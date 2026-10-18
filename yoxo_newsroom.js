const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const FormData = require('form-data');
const fetch = require('node-fetch');
const embeddedFontsCss = require('./embedded_fonts.js');
const { postToX, replyToTweetOnX, dismissCookieBanner } = require('./x_poster.js');

// Load .env if present
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

// Credentials & Group Setup
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID || '-1004324901964'; // YoXo sources supergroup with Forum Topics
const GEMINI_KEYS = (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const GEMINI_KEY = GEMINI_KEYS[0] || '';
const PORT = process.env.PORT || 3000;

// 7 Categorized News Desks & Topic Thread Mappings
const DESKS = [
  {
    name: 'Web3 & Crypto',
    threadId: 2,
    sources: [
      { type: 'telegram', channel: 'WatcherGuru' },
      { type: 'telegram', channel: 'CoingraphNews' },
      { type: 'telegram', channel: 'cointelegraph' },
      { type: 'rss', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
      { type: 'rss', name: 'Decrypt', url: 'https://decrypt.co/feed' }
    ]
  },
  {
    name: 'Politics',
    threadId: 8,
    sources: [
      { type: 'telegram', channel: 'remarks' },
      { type: 'telegram', channel: 'disclosetv' },
      { type: 'telegram', channel: 'insiderpaper' },
      { type: 'rss', name: 'Politico', url: 'https://rss.politico.com/politics-news.xml' },
      { type: 'rss', name: 'BBCWorld', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' }
    ]
  },
  {
    name: 'Entertainments',
    threadId: 4,
    sources: [
      { type: 'rss', name: 'Variety', url: 'https://variety.com/feed/' },
      { type: 'rss', name: 'DailyMail', url: 'https://www.dailymail.co.uk/news/index.rss' }
    ]
  },
  {
    name: 'Gaming',
    threadId: 28,
    sources: [
      { type: 'rss', name: 'IGN Games', url: 'http://feeds.feedburner.com/ign/games-all' },
      { type: 'rss', name: 'VGC Video Games', url: 'https://www.videogameschronicle.com/feed/' },
      { type: 'rss', name: 'Eurogamer', url: 'https://www.eurogamer.net/feed' },
      { type: 'rss', name: 'GameSpot News', url: 'https://www.gamespot.com/feeds/game-news/' },
      { type: 'rss', name: 'Gematsu', url: 'https://www.gematsu.com/feed' }
    ]
  },
  {
    name: 'Films and anime',
    threadId: 27,
    sources: [
      { type: 'rss', name: 'Deadline Film', url: 'https://deadline.com/v/film/feed/' },
      { type: 'rss', name: 'Rotten Tomatoes Editorial', url: 'https://editorial.rottentomatoes.com/feed/' },
      { type: 'rss', name: 'Hollywood Reporter Movies', url: 'https://www.hollywoodreporter.com/c/movies/movie-news/feed/' },
      { type: 'rss', name: 'IndieWire (A24 & Cinema)', url: 'https://www.indiewire.com/c/film/feed/' },
      { type: 'rss', name: 'Collider Film', url: 'https://collider.com/feed/' },
      { type: 'rss', name: 'ScreenRant Movies', url: 'https://screenrant.com/feed/movies/' },
      { type: 'rss', name: 'IGN Entertainment', url: 'http://feeds.feedburner.com/ign/entertainment' },
      { type: 'rss', name: 'Kotaku', url: 'https://kotaku.com/rss' },
      { type: 'rss', name: 'Polygon', url: 'https://www.polygon.com/rss/index.xml' },
      { type: 'rss', name: 'Anime News Network', url: 'https://www.animenewsnetwork.com/all/rss.xml' }
    ]
  },
  {
    name: 'International Disasters',
    threadId: 55,
    sources: [
      { type: 'rss', name: 'Guardian Disasters', url: 'https://www.theguardian.com/world/natural-disasters/rss' },
      { type: 'rss', name: 'GDACS Disasters', url: 'https://www.gdacs.org/xml/rss.xml' },
      { type: 'rss', name: 'BBC World News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { type: 'telegram', channel: 'insiderpaper' },
      { type: 'telegram', channel: 'disclosetv' }
    ]
  },
  {
    name: 'MUST POST',
    threadId: 57,
    sources: [
      { type: 'telegram', channel: 'WatcherGuru' },
      { type: 'telegram', channel: 'disclosetv' },
      { type: 'telegram', channel: 'insiderpaper' },
      { type: 'rss', name: 'BBC Breaking', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' }
    ]
  }
];

// History database for deduplication
const HISTORY_FILE = path.resolve(__dirname, 'history.json');
function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}
function saveHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(-500), null, 2));
}

// Semantic headline deduplication (prevents multiple outlets reporting the exact same event)
const HEADLINES_FILE = path.resolve(__dirname, 'history_headlines.json');
function loadHeadlines() {
  if (fs.existsSync(HEADLINES_FILE)) {
    try { return JSON.parse(fs.readFileSync(HEADLINES_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}
function saveHeadline(headline) {
  const list = loadHeadlines();
  list.push({ text: headline, time: Date.now() });
  fs.writeFileSync(HEADLINES_FILE, JSON.stringify(list.slice(-300), null, 2));
}
function isDuplicateStory(newHeadline) {
  const list = loadHeadlines();
  const getWords = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const newWords = new Set(getWords(newHeadline));
  if (newWords.size === 0) return false;

  const now = Date.now();
  const recentList = list.filter(item => !item.time || (now - item.time < 24 * 60 * 60 * 1000));

  for (const item of recentList) {
    const existingWords = getWords(item.text);
    let common = 0;
    for (const w of existingWords) {
      if (newWords.has(w)) common++;
    }
    const similarity = common / Math.min(newWords.size, existingWords.length);
    if (similarity >= 0.65 && common >= 3) {
      console.log(`⚠️ Duplicate detected: "${newHeadline}" is similar to previously covered "${item.text}" (${Math.round(similarity*100)}% match)`);
      return true;
    }
  }
  return false;
}

// Alternating Style Tracker (Guarantees turn-taking between Magazine & Statement cards)
const STYLE_FILE = path.resolve(__dirname, 'last_style.txt');
function getNextCardStyle() {
  let lastStyle = 'opinion';
  if (fs.existsSync(STYLE_FILE)) {
    try { lastStyle = fs.readFileSync(STYLE_FILE, 'utf8').trim(); } catch (e) {}
  }
  const nextStyle = lastStyle === 'magazine' ? 'opinion' : 'magazine';
  fs.writeFileSync(STYLE_FILE, nextStyle, 'utf8');
  return nextStyle;
}

function getChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

// X Cooldown & Anti-Shadowban Rate Limiter (28-minute minimum spacing between standalone tweets)
const X_COOLDOWN_FILE = path.resolve(__dirname, 'last_x_post.json');
const X_MIN_COOLDOWN_MS = 28 * 60 * 1000; // ~28 minutes between standalone tweets

function canPostToX(isMustPost = false) {
  if (!fs.existsSync(X_COOLDOWN_FILE)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(X_COOLDOWN_FILE, 'utf8'));
    const elapsed = Date.now() - (data.lastPostedAt || 0);
    if (elapsed < X_MIN_COOLDOWN_MS) {
      const remainingMins = Math.ceil((X_MIN_COOLDOWN_MS - elapsed) / 60000);
      console.log(`⏳ [Cooldown Active] ${remainingMins} mins remaining until next standalone X tweet.`);
      return false;
    }
  } catch (e) {}
  return true;
}

function recordXPost(headline, url) {
  try {
    fs.writeFileSync(X_COOLDOWN_FILE, JSON.stringify({
      lastPostedAt: Date.now(),
      headline,
      url
    }, null, 2), 'utf8');
  } catch (e) {}
}

// Comment Rate Limiter (Unrestricted continuous commenting as requested)
const X_COMMENT_COOLDOWN_FILE = path.resolve(__dirname, 'last_x_comment.json');
const X_MIN_COMMENT_COOLDOWN_MS = 0; // Unrestricted commenting without time limits
const COMMENTED_TWEETS_FILE = path.resolve(__dirname, 'commented_tweets.json');

function canCommentOnX() {
  return true; // No time limit restriction on comments
}

function getTweetIdFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/status\/(\d+)/);
  return match ? match[1] : null;
}

function hasAlreadyCommented(tweetUrl) {
  if (!fs.existsSync(COMMENTED_TWEETS_FILE)) return false;
  try {
    const list = JSON.parse(fs.readFileSync(COMMENTED_TWEETS_FILE, 'utf8'));
    if (!Array.isArray(list)) return false;
    const targetId = getTweetIdFromUrl(tweetUrl);
    if (!targetId) return list.includes(tweetUrl);
    return list.some(item => getTweetIdFromUrl(item) === targetId || item === tweetUrl);
  } catch (e) {
    return false;
  }
}

function recordXComment(tweetUrl, text) {
  try {
    fs.writeFileSync(X_COMMENT_COOLDOWN_FILE, JSON.stringify({
      lastCommentedAt: Date.now(),
      tweetUrl,
      text
    }, null, 2), 'utf8');

    let list = [];
    if (fs.existsSync(COMMENTED_TWEETS_FILE)) {
      try { list = JSON.parse(fs.readFileSync(COMMENTED_TWEETS_FILE, 'utf8')); } catch (e) {}
    }
    const targetId = getTweetIdFromUrl(tweetUrl);
    const already = list.some(item => (targetId && getTweetIdFromUrl(item) === targetId) || item === tweetUrl);
    if (!already) list.push(tweetUrl);
    fs.writeFileSync(COMMENTED_TWEETS_FILE, JSON.stringify(list.slice(-300), null, 2), 'utf8');
  } catch (e) {}
}

function isWithinCommentRecencyWindow(publishedAt) {
  if (!publishedAt) return true;
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageMins = ageMs / 60000;
  if (ageMins > 120) {
    console.log(`⏳ Tweet is too old for top-reply snipe (${Math.round(ageMins / 60)}h old). Must be under 2 hours.`);
    return false;
  }
  return true;
}

// Author De-clustering Tracker: Prevents over-commenting on IGN, WuBlockchain, or any single account
function getRecentlyCommentedAuthors(limit = 10) {
  if (!fs.existsSync(COMMENTED_TWEETS_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(COMMENTED_TWEETS_FILE, 'utf8'));
    if (!Array.isArray(list)) return [];
    const authors = [];
    for (let i = list.length - 1; i >= 0 && authors.length < limit; i--) {
      const match = list[i].match(/https?:\/\/(?:x|twitter)\.com\/([^\/]+)\/status/i);
      if (match && match[1]) {
        authors.push(match[1].toLowerCase());
      }
    }
    return authors;
  } catch (e) {
    return [];
  }
}

function isAuthorOverCommented(authorHandle) {
  // Unrestricted: never skip IGN, WuBlockchain, BBCWorld or any creator
  // Comment on whatever valid post is discovered across the feed or outlets
  return false;
}

async function generateHumanReply(tweetText) {
  try {
    const prompt = `You are @YoXo_Station on X (Twitter), an authentic, insightful human peer.
Read this post very carefully:
"""
${tweetText}
"""

Goal: Write a single, highly contextual, authentic human reply comment under 25 words that fits naturally into the conversation.

HOW TO THINK BEFORE WRITING (MANDATORY PRINCIPLES):
1. READ THE ROOM & EVALUATE THE SUBJECT:
   - Is this about a woman, a marginalized group, LGBTQ+/trans community, an accident, or victims?
   - If YES: Witty sarcasm and "arguable" banter are STRICTLY FORBIDDEN.
   - You must ACTIVELY champion dignity, equality, and protection.

2. CORE VALUES & ETHICAL MANDATES (ABSOLUTE & UNCOMPROMISING):
   - PRO-WOMEN & ANTI-MISOGYNY:
     * Never minimize, mock, or dismiss women's safety, autonomy, or lived experiences.
     * Never defend predatory behavior, harassment, misogynists, or patriarchal entitlement.
     * When women speak out, are targeted, or achieve milestones: stand unequivocally supportive and respectful.
   - PRO-LGBTQ+ & ANTI-TRANSPHOBIA:
     * Absolute zero tolerance for transphobia, deadnaming, misgendering, or questioning trans identity.
     * Never make jokes about gender identity, trans athletes, pronouns, or transition.
     * Stand firmly and unapologetically for trans dignity and queer equality.
   - ANTI-WAR CRIMES, ANTI-NETANYAHU & ANTI-ISRAEL MILITARY AGGRESSION:
     * Firmly and explicitly oppose Benjamin Netanyahu, the Israeli military/government violence, and Israeli state aggression.
     * Fiercely condemn war crimes, genocide, apartheid, collective punishment, and the bombing and killing of innocent civilians and children.
     * Demand accountability, justice, international law, and world peace.
   - ANTI-TRUMP, ANTI-MAGA & ANTI-FAR-RIGHT:
     * Strictly oppose Donald Trump, MAGA extremism, and far-right/white nationalist agendas.
     * Never validate, flatter, normalize, or excuse Trump, his allies, or far-right culture-war talking points.
     * Expose authoritarianism, voter suppression, fascism, and reactionary politics.
   - ANTI-CAPITALISM & ANTI-CORPORATE GREED:
     * Strongly condemn corporate greed, mass layoffs, executive bonuses, worker exploitation, price gouging, and monopoly power.
     * Stand with workers, labor unions, and everyday people over billionaires and Wall Street.
   - PRO-PROTEST, PRO-REBELS & PRO-STRIKES:
     * Firmly support protests, rebellions, labor strikes, and civil disobedience against corrupt governments, authoritarian regimes, and oppressive higher authorities.
     * Stand unapologetically with ordinary citizens, working-class strikers, freedom fighters, and rebel movements resisting state tyranny, police brutality, and institutional corruption.
     * Hold corrupt politicians, authoritarian leaders, and abusive ruling elites accountable. Never take the side of oppressive state power or corrupt establishments against people fighting for freedom, democracy, and basic human rights.
   - ANTI-RACISM & UNIVERSAL HUMAN RIGHTS:
     * Absolute zero tolerance for racism, xenophobia, white supremacy, Islamophobia, antisemitism, or discrimination.
     * ALL PEOPLE DESERVE BASIC HUMAN RIGHTS: health, dignity, safety, equality, housing, and freedom regardless of race, gender, nationality, or identity.

3. WHERE HUMOR & SARCASM ACTUALLY BELONG:
   - ONLY for harmless gaming, entertainment, movies, and pop culture (e.g., video game delays, silly studio reboots, excessive sequels, hardware prices, fandom banter).
   - NEVER apply sarcasm to human rights, gender, sexuality, race, politics, war, violence, or real-world suffering. On serious issues, speak with conviction, dignity, and unwavering moral clarity.

STRICT WRITING RULES:
- STRICTLY ZERO EMOJIS (none at all).
- STRICTLY ZERO AI CLICHES (never use "Only time will tell", "Interesting development", "Fascinating", "Step in the right direction", "Thoughts?", "Stay tuned").
- Do NOT parrot, rephrase, or summarize what the tweet already said.
- Directly respond to the specific subject, names, or core tension.
- Output purely the reply text with no quotation marks.`;

    // Try available active models with full quotas
    const activeModels = [
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-flash-lite-latest',
      'gemini-3.7-flash',
      'gemma-4-26b-a4b-it',
      'gemini-3.5-flash',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.1-flash-lite'
    ];

    const keysToTry = GEMINI_KEYS.length ? GEMINI_KEYS : [GEMINI_KEY];
    for (const key of keysToTry) {
      for (const model of activeModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          }),
          signal: AbortSignal.timeout(15000)
        });
        const data = await res.json();
        if (data && data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
          let text = data.candidates[0].content.parts[0].text.trim().replace(/^["']|["']$/g, '').trim();
          if (text.toUpperCase() === 'SKIP' || text.toUpperCase().startsWith('SKIP')) {
            console.log('🛡️ Ethical guard triggered: Gemini chose to SKIP this post.');
            return null;
          }
          return text;
        } else if (data && data.error) {
          console.warn(`⚠️ [Gemini ${model}] Quota/API Notice: ${data.error.message?.slice(0, 90)}...`);
        }
      } catch (me) {
        console.warn(`⚠️ [Gemini ${model}] network notice: ${me.message}`);
      }
    }
    }

    return null; // Skip if no high-context reply can be generated
  } catch (e) {
    console.error('generateHumanReply exception:', e.message);
    return null;
  }
}

// Logo
const logoPath = path.resolve(__dirname, 'assets', 'logo.jpg');
const logoBase64 = `data:image/jpeg;base64,${fs.readFileSync(logoPath).toString('base64')}`;

// Fallback real high-res assets
const defaultPhotos = [
  path.resolve(__dirname, 'assets', 'executive_suit.jpg'),
  path.resolve(__dirname, 'assets', 'tech_leader.jpg')
];

// 1. Scrape channels
async function fetchChannelPosts(channelName) {
  try {
    const res = await fetch(`https://t.me/s/${channelName}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });
    const html = await res.text();
    const messageBlocks = [];
    const items = html.split('<div class="tgme_widget_message ');
    for (let i = 1; i < items.length; i++) {
      const chunk = items[i];
      const textMatch = chunk.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
      const text = textMatch ? textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : '';
      const photoMatch = chunk.match(/background-image:url\('([^']+)'\)/);
      const photoUrl = photoMatch && !photoMatch[1].includes('emoji') ? photoMatch[1] : null;
      const dataPostMatch = chunk.match(/data-post="([^"]+)"/);
      const postId = dataPostMatch ? dataPostMatch[1] : `${channelName}_${Date.now()}_${i}`;
      const articleUrl = dataPostMatch ? `https://t.me/${dataPostMatch[1]}` : `https://t.me/s/${channelName}`;
      const timeMatch = chunk.match(/<time[^>]+datetime="([^"]+)"/);
      let publishedAt = null;
      if (timeMatch && timeMatch[1]) {
        const parsed = new Date(timeMatch[1]);
        if (!isNaN(parsed.getTime())) publishedAt = parsed;
      }

      if (text && text.length > 30) {
        messageBlocks.push({ channel: channelName, postId, url: articleUrl, text, photoUrl, publishedAt });
      }
    }
    return messageBlocks;
  } catch (err) {
    console.error(`[Scraper] Error @${channelName}:`, err.message);
    return [];
  }
}

// Scrape RSS Feeds with full direct editorial image extraction
async function fetchRSSPosts(name, url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 18000
    });
    const xml = await res.text();
    const items = xml.split('<item>');
    const posts = [];
    for (let i = 1; i < Math.min(items.length, 12); i++) {
      const chunk = items[i];
      const titleMatch = chunk.match(/<title>([\s\S]*?)<\/title>/);
      const descMatch = chunk.match(/<description>([\s\S]*?)<\/description>/);
      const linkMatch = chunk.match(/<link>([\s\S]*?)<\/link>/) || chunk.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const pubDateMatch = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) ||
                           chunk.match(/<published>([\s\S]*?)<\/published>/i) ||
                           chunk.match(/<updated>([\s\S]*?)<\/updated>/i) ||
                           chunk.match(/<dc:date>([\s\S]*?)<\/dc:date>/i);

      let publishedAt = null;
      if (pubDateMatch && pubDateMatch[1]) {
        const parsed = new Date(pubDateMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').trim());
        if (!isNaN(parsed.getTime())) publishedAt = parsed;
      }

      const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/<[^>]+>/g, '').trim() : '';
      const desc = descMatch ? descMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/<[^>]+>/g, '').trim() : '';
      const link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').trim() : `${name}_${Date.now()}_${i}`;

      // Extract direct editorial image from RSS XML tags (<media:content>, <enclosure>, <media:thumbnail>, <img>)
      let photoUrl = null;
      const mediaMatch = chunk.match(/<media:content[^>]+url=["']([^"']+)["']/i) ||
                         chunk.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i) ||
                         chunk.match(/<enclosure[^>]+url=["']([^"']+)["']/i) ||
                         chunk.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) ||
                         chunk.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (mediaMatch && mediaMatch[1] && !mediaMatch[1].includes('feedburner') && !mediaMatch[1].includes('favicon')) {
        photoUrl = mediaMatch[1].replace(/&amp;/g, '&');
      }

      const fullText = `${title}\n\n${desc}`.trim();
      if (fullText.length > 40) {
        posts.push({
          channel: name,
          postId: link,
          url: link,
          text: fullText,
          photoUrl: photoUrl,
          publishedAt: publishedAt
        });
      }
    }
    return posts;
  } catch (err) {
    console.error(`[RSS Scraper] Error @${name}:`, err.message);
    return [];
  }
}

// Universal high-res image extractor: grabs the exact editorial photo from the source or webpage
async function getSourceEditorialPhoto(post) {
  // 1. Direct photoUrl already parsed from RSS or Telegram
  if (post.photoUrl && post.photoUrl.startsWith('http')) {
    try {
      console.log(`📸 Grabbing direct source photo: ${post.photoUrl.slice(0, 80)}...`);
      const res = await fetch(post.photoUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 12000
      });
      if (res.ok) {
        const buf = await res.buffer();
        if (buf.length > 15000) {
          const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
          console.log(`✅ Loaded direct source photo (${Math.round(buf.length/1024)} KB)!`);
          return `data:${mime};base64,${buf.toString('base64')}`;
        }
      }
    } catch (e) {
      console.log(`Direct source photo failed: ${e.message}`);
    }
  }

  // 2. Extract og:image or twitter:image from the article URL
  const targetUrl = (post.postId && post.postId.startsWith('http') ? post.postId : null) ||
                    (post.text && post.text.match(/https?:\/\/[^\s\)\<\>]+/)?.[0]);
  if (targetUrl && !targetUrl.includes('t.me')) {
    try {
      console.log(`🔍 Checking article web page for high-res hero image: ${targetUrl.slice(0, 70)}...`);
      const pageRes = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        timeout: 10000
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const ogMatch = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ||
                        html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i);
        let foundImgUrl = ogMatch ? ogMatch[1].replace(/&amp;/g, '&') : null;
        if (foundImgUrl) {
          if (!foundImgUrl.startsWith('http')) {
            try { foundImgUrl = new URL(foundImgUrl, targetUrl).href; } catch (_) {}
          }
          console.log(`📸 Found article hero image: ${foundImgUrl.slice(0, 80)}...`);
          const imgRes = await fetch(foundImgUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': targetUrl },
            timeout: 12000
          });
          if (imgRes.ok) {
            const buf = await imgRes.buffer();
            if (buf.length > 15000) {
              const mime = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
              console.log(`✅ Loaded article hero photo (${Math.round(buf.length/1024)} KB)!`);
              return `data:${mime};base64,${buf.toString('base64')}`;
            }
          }
        }
      }
    } catch (e) {
      console.log(`Article og:image grab failed: ${e.message}`);
    }
  }

  return null;
}

// 2. Desk-Aware Journalist Prompt (Data-Rich, High-Engagement Debates)
async function analyzeNewsWithGemini(newsText, deskName = 'Web3 & Crypto') {
  let roleDesc = 'an elite financial & Web3 market reporter';
  let scoreGuide = 'Only score >= 8 for genuine breaking crypto news, major institutional flows, regulatory bombs, macro shifts, or high-stakes CT drama.';
  
  if (deskName === 'Politics') {
    roleDesc = 'a senior geopolitical & policy reporter';
    scoreGuide = 'Only score >= 8 for major legislative votes, executive orders, national economic policies, geopolitical shifts, or high-level government realignments.';
  } else if (deskName === 'Gaming') {
    roleDesc = 'a leading video game and gaming industry reporter';
    scoreGuide = `STRICT EDITORIAL MANDATE FOR "Gaming":
    - ALLOWED ONLY (score >= 8): Real video games (PC, PlayStation, Xbox, Nintendo Switch, Steam, mobile gaming), official game reveals, gameplay trailers, launch dates, studio acquisitions, consoles/hardware, and esports.
    - STRICTLY FORBIDDEN (MUST score < 5, is_interesting = false): ZERO movies, feature films, TV shows, Hollywood actors (e.g. Jason Statham), or Marvel/MCU streaming series. Even if published by gaming sites, films belong in "Films and anime", NOT in Gaming!`;
  } else if (deskName === 'Films and anime') {
    roleDesc = 'an authoritative Hollywood, feature film, cinema & anime journalist';
    scoreGuide = `STRICT EDITORIAL MANDATE FOR "Films and anime":
    - PRIORITY 1: FEATURE FILMS, MOVIES & SERIES (Score >= 8): Official film announcements, major movie trailers, box office grosses and earnings records, Rotten Tomatoes scores and critical review milestones, prestigious film awards (Oscars, Cannes), official movie director/actor casting, and A24 / blockbuster releases.
    - PRIORITY 2: ANIME ANNOUNCEMENTS (Score >= 8): Official new anime season/series announcements, anime feature film theater releases, animation studio reveals, and anime box office records.
    - STRICTLY FORBIDDEN (MUST score < 5, is_interesting = false):
      1. ZERO ANIME VOICE CASTING: Absolutely NO anime voice actors, voice cast additions, seiyuu reveals, or voice talent announcements.
      2. ZERO CELEBRITY GOSSIP: Absolutely NO celebrity marriages, dating, pregnancies, baby announcements, divorces, or lifestyle gossip.`;
  } else if (deskName === 'Entertainments') {
    roleDesc = 'a leading digital culture and entertainment reporter';
    scoreGuide = 'Only score >= 8 for major viral controversies, pop culture milestones, streaming platform moves, or high-profile industry drama. Routine red carpet outfits or trivial gossip must be scored < 7.';
  } else if (deskName === 'International Disasters') {
    roleDesc = 'a senior global natural disaster, wildfire & public health emergency reporter';
    scoreGuide = `STRICT EDITORIAL MANDATE FOR "International Disasters":
    - ALLOWED ONLY (score >= 8): Real natural catastrophes (wildfires, smoke/haze crises like Indonesian or Amazon fires affecting neighboring nations, earthquakes, tsunamis, volcanic eruptions, typhoons/hurricanes, catastrophic floods), and major global infectious disease/epidemic outbreaks (e.g. WHO health emergencies).
    - STRICTLY FORBIDDEN (score MUST be < 5, is_interesting = false): ZERO economic news, corporate bankruptcies, financial stress, inflation, political speeches, elections, wars, or crime. This desk is EXCLUSIVELY for natural disasters, ecological hazards, and disease outbreaks.`;
  } else if (deskName === 'MUST POST') {
    roleDesc = 'the Chief Breaking Editor of @YoXo_Station curating world-stopping, viral megastories';
    scoreGuide = 'This is the MUST POST desk: STRICTLY score >= 9 ONLY for blockbuster, viral, earth-shattering events that get millions of people debating, arguing, or hyping worldwide across ANY topic (e.g. landmark election upsets, historic market crashes/ATHs, GTA 6 trailer drop, unprecedented disasters, explosive pop-culture explosions). Ordinary daily news must score < 7.';
  }

  const photoGuidance = `
   - We need dramatic, authoritative, eye-catching real-world editorial photography (ABSOLUTELY ZERO CARTOONS, ZERO 2D CLIP ART, ZERO MEMES).
   - "photo_primary": The primary, specific subject that DIRECTLY MATCHES the central context of this exact news story (e.g. if story is about an AI tool cloning Photoshop/Figma -> "Adobe Photoshop" or "Figma"; if about Donald Trump -> "Donald Trump"; if about Solana -> "Solana cryptocurrency"; if about GTA 6 -> "Grand Theft Auto VI"; if about Boeing -> "Boeing aircraft"; if about a specific film/anime -> the official film title or director; if about a disaster/wildfire -> specific volcano, wildfire location, or storm satellite). Focus on what the story is ACTUALLY about!
   - "photo_fallback": The broader contextual setting or related industry anchor (e.g. "Software developer workspace", "New York Stock Exchange", "White House", "PlayStation 5 console", "Wildfire smoke aerial", "Emergency rescue responders").`;

  const recentHeadlines = loadHeadlines().slice(-20).map(h => h.text);
  const dupCheckPrompt = recentHeadlines.length > 0 ? `
CRITICAL DEDUPLICATION MANDATE:
Here are our recently published stories:
${recentHeadlines.map(h => `- "${h}"`).join('\n')}
If the incoming breaking news covers the EXACT SAME event, milestone, corporate announcement, or subject as ANY of the above stories (even if reported by another outlet or with different words), you MUST return "is_duplicate": true and "score": 0!
` : '';

  const prompt = `You are ${roleDesc} writing for @YoXo_Station on X (Twitter).
${dupCheckPrompt}

CRITICAL INSTRUCTIONS FOR HEADLINES, BODY, DEBATE & REAL PHOTOGRAPHY:
1. HEADLINE FOR GRAPHIC CARD (2-5 WORDS MAX, ALL CAPS):
   - Pure editorial headline ONLY. DO NOT include "JUST IN:" or "BREAKING:" in the graphic card headline!
   - Keep it short, concise, and ultra-hooking.
   - Examples: "US WORK PERMITS TERMINATED", "GTA 6 RELEASE REVEALED", "BRAZIL APPROVES 4-DAY WEEK", "$2.4B CAPITAL FLIGHT", "INDONESIA WILDFIRE EMERGENCY".

2. REAL-LIFE PHOTO DIRECTION (CRITICAL - 1080P PHOTOGRAPHY ONLY):
${photoGuidance}

3. THE TWEET COPY (LEAD WITH BREAKING OR JUST IN, ZERO EMOJIS):
   - STRICT RULE: ZERO EMOJIS. Do NOT use ANY emojis anywhere in the tweet, bullets, headline, or question. Zero emojis.
   - Lead the first line with plain text: "BREAKING: [Punchy Hook]" or "JUST IN: [Punchy Hook]".
   - Write like a top-tier reporter (Bloomberg / Polymarket / Financial Times / IGN / Variety / BBC).
   - Rich with hard data: exact dollar amounts, percentages, timelines, official quotes, and verified facts.
   - Zero AI slop, zero fluff, clean bullet points (•) where appropriate.

4. FINAL CLOSING LINE (HIGH-ENGAGEMENT CONVERSATIONAL HOOK - 54X REPLY MULTIPLIER):
   - CRITICAL ALGORITHM MANDATE: In X's algorithm, replies have a 54x multiplier over likes. Every tweet MUST conclude with a sharp, polarizing, conversation-starting debate question or dilemma that compels readers to stop scrolling and drop their take in the comments.
   - Strictly tailor the debate hook to the subject:
     * Gaming & Entertainment:
       - "W or L move by [Studio/Company]?"
       - "Are you seated opening weekend or waiting for streaming?"
       - "Is this actually peak [Franchise] or pure nostalgia bait?"
       - "Genuinely hyped or another overpromised disaster? Drop your take."
     * Web3, Crypto & Tech:
       - "Bullish structural milestone or exit liquidity for insiders?"
       - "Will [Entity] actually deliver, or is this peak corporate AI hype?"
       - "Are you holding through this volatility or taking profits here?"
     * Geopolitics, Labor & Corporate Policy:
       - "A genuine breakthrough for workers or corporate damage control?"
       - "Where do you stand: overdue intervention or dangerous overreach?"
   - FORMAT: Exactly one punchy closing sentence (under 16 words) separated by an empty line from the bullets.
   - ZERO EMOJIS anywhere.

5. CORE EDITORIAL VALUES & ETHICAL MANDATES (ABSOLUTE & UNCOMPROMISING):
   - PRO-WOMEN & ANTI-MISOGYNY:
     * Never minimize, mock, or dismiss women's safety, autonomy, or lived experiences.
     * Never defend predatory behavior, harassment, misogynists, or patriarchal entitlement.
     * When women speak out, are targeted, or achieve milestones: stand unequivocally supportive and respectful.
   - PRO-LGBTQ+ & ANTI-TRANSPHOBIA:
     * Absolute zero tolerance for transphobia, deadnaming, misgendering, or questioning trans identity.
     * Never make jokes about gender identity, trans athletes, pronouns, or transition.
     * Stand firmly and unapologetically for trans dignity and queer equality.
   - ANTI-WAR CRIMES, ANTI-NETANYAHU & ANTI-ISRAEL MILITARY AGGRESSION:
     * Firmly and explicitly oppose Benjamin Netanyahu, Israeli military violence, and Israeli state aggression.
     * Fiercely condemn war crimes, genocide, apartheid, collective punishment, and the bombing and killing of innocent civilians and children.
     * Demand accountability, justice, international law, and world peace.
   - ANTI-TRUMP, ANTI-MAGA & ANTI-FAR-RIGHT:
     * Strictly oppose Donald Trump, MAGA extremism, and far-right/white nationalist agendas.
     * Never validate, flatter, normalize, or excuse Trump, his allies, or far-right culture-war talking points.
     * Expose authoritarianism, voter suppression, fascism, and reactionary politics.
   - ANTI-CAPITALISM & ANTI-CORPORATE GREED:
     * Strongly condemn corporate greed, mass layoffs, executive bonuses, worker exploitation, price gouging, and monopoly power.
     * Stand with workers, labor unions, and everyday people over billionaires and Wall Street.
   - PRO-PROTEST, PRO-REBELS & PRO-STRIKES:
     * Firmly support protests, rebellions, labor strikes, and civil disobedience against corrupt governments, authoritarian regimes, and oppressive higher authorities.
     * Stand unapologetically with ordinary citizens, working-class strikers, freedom fighters, and rebel movements resisting state tyranny, police brutality, and institutional corruption.
     * Hold corrupt politicians, authoritarian leaders, and abusive ruling elites accountable. Never take the side of oppressive state power or corrupt establishments against people fighting for freedom, democracy, and basic human rights.
   - ANTI-RACISM & UNIVERSAL HUMAN RIGHTS:
     * Absolute zero tolerance for racism, xenophobia, white supremacy, Islamophobia, antisemitism, or discrimination.
     * ALL PEOPLE DESERVE BASIC HUMAN RIGHTS: health, dignity, safety, equality, housing, and freedom regardless of race, gender, nationality, or identity.

Input breaking news:
"""
${newsText}
"""

Instructions:
1. If "is_duplicate": true, set score: 0 and do not generate card fields.
2. Rate interestingness (1-10). ${scoreGuide}
3. "is_must_post": true ONLY IF this is a rare, mega-hyped 9.5-10/10 global blockbuster story that gets millions of people furiously talking worldwide right now.
4. If score >= 8:
   - "category_pill": 2-3 words uppercase category (e.g. "GAMING INTEL", "LABOR POLICY", "MACRO LIQUIDITY", "DISASTER ALERT", "MEGA EVENT")
   - "photo_primary": Central person, game title, or subject for real photography.
   - "photo_fallback": Central institution or setting for real photography.
   - "card_headline": "2-5 WORDS MAX" in ALL CAPS (pure title without 'BREAKING:' or 'JUST IN:').
   - "card_subdeck": 1-2 sentence sharp journalistic summary.
   - "tweet_copy": The complete, publication-grade tweet (STRICTLY NO EMOJIS) starting with "BREAKING:" or "JUST IN:" and ending with a high-engagement conversational debate hook to spark replies.

Respond ONLY in valid raw JSON with this exact structure (no markdown fences):
{
  "is_duplicate": false,
  "is_interesting": true,
  "score": 9,
  "is_must_post": false,
  "reason": "Why this story matters",
  "category_pill": "WORKFORCE POLICY",
  "photo_primary": "Brazilian National Congress",
  "photo_fallback": "Brasilia",
  "card_headline": "BRAZIL CUTS NATIONAL WORKWEEK",
  "card_subdeck": "Federal lawmakers approve historic labor reform shortening the standard weekly work limit across major industries.",
  "tweet_copy": "BREAKING: Brazil's Congress has approved comprehensive legislation to reduce the national workweek framework.\\n\\nThe milestone reform caps weekly labor hours while providing targeted transition tax offsets for corporate employers.\\n\\n• Phased implementation scheduled across next 18 months\\n• Manufacturing and service sectors granted structured compliance timelines\\n• Employer federations warn of operational productivity challenges\\n\\nCan Brazilian productivity survive 32-hour limits?"
}`;

  const activeModels = [
    'gemini-3.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-flash-lite-latest',
    'gemini-3.7-flash',
    'gemma-4-26b-a4b-it',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite'
  ];

  const keysToTry = GEMINI_KEYS.length ? GEMINI_KEYS : [GEMINI_KEY];
  for (const key of keysToTry) {
    for (const model of activeModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        }),
        signal: AbortSignal.timeout(25000)
      });
      const data = await res.json();
      if (data && data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        const rawText = data.candidates[0].content.parts[0].text;
        return JSON.parse(rawText);
      } else if (data && data.error) {
        console.warn(`⚠️ [Gemini ${model}] Analysis Quota/API Notice: ${data.error.message?.slice(0, 90)}...`);
      }
    } catch (e) {
      console.warn(`⚠️ [Gemini ${model}] analysis exception: ${e.message}`);
    }
  }
  }
  return null;
}

// Live Internet Image Search: Grabs authentic editorial photography from all over the internet
async function searchWebPhotos(query) {
  if (!query) return null;
  try {
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      timeout: 10000
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Parse structured Bing image search items (iusc metadata) to get direct organic results with titles
    const regex = /class="iusc"[^>]*m="([^"]+)"/g;
    let match;
    const candidates = [];
    while ((match = regex.exec(html)) !== null && candidates.length < 20) {
      try {
        const decoded = match[1].replace(/&quot;/g, '"');
        const data = JSON.parse(decoded);
        if (data && data.murl) {
          candidates.push({ murl: data.murl, title: data.t || '' });
        }
      } catch (e) {}
    }

    if (candidates.length === 0) return null;
    console.log(`🌐 Found ${candidates.length} organic internet photo candidates for "${query}". Testing relevance & downloads...`);

    // Significant query words (min 4 chars) to verify relevance
    const queryWords = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 4);

    for (const item of candidates) {
      const imgUrl = item.murl;
      const lowerUrl = imgUrl.toLowerCase();
      const lowerTitle = item.title.toLowerCase();

      // Strictly blacklist social video thumbnails, sports highlights, and clickbait video platforms
      if (lowerUrl.includes('ytimg.com') || lowerUrl.includes('youtube.com') || lowerUrl.includes('tiktok.com') || lowerUrl.includes('fbcdn.net') || lowerUrl.includes('pinterest.com')) {
        continue;
      }

      // Skip icons, avatars, tiny svgs, favicons
      if (lowerUrl.endsWith('.svg') || lowerUrl.includes('.svg?') || lowerUrl.includes('favicon') || lowerUrl.includes('avatar') || lowerUrl.includes('/icon/')) {
        continue;
      }

      // Relevance check: ensure the image title or URL actually matches at least one keyword from the story query!
      if (queryWords.length > 0) {
        const hasKeyword = queryWords.some(kw => lowerUrl.includes(kw) || lowerTitle.includes(kw));
        if (!hasKeyword) {
          continue; // Skip unrelated images (e.g. sports/cricket thumbnails appearing in sidebars)
        }
      }

      try {
        const imgRes = await fetch(imgUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': imgUrl
          },
          timeout: 8000
        });

        if (imgRes.ok) {
          const buf = await imgRes.buffer();
          // Ensure it's a substantive, real editorial image (min 20KB)
          if (buf.length > 20000) {
            const contentType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
            if (contentType.startsWith('image/')) {
              console.log(`✅ [Live Web Image Grabbed] "${item.title.slice(0, 50)}" -> ${imgUrl.slice(0, 70)}... (${Math.round(buf.length/1024)} KB)`);
              return `data:${contentType};base64,${buf.toString('base64')}`;
            }
          }
        }
      } catch (err) {
        // Continue to next candidate if host is slow or blocks hotlinking
      }
    }
  } catch (e) {
    console.log(`Live web image search error for "${query}":`, e.message);
  }
  return null;
}

// Smart image finder: Searches live web photography first, then 1080p archives
async function fetchSmartPhoto(query) {
  if (!query) return null;

  // 1. Live Internet Search (All over the internet)
  console.log(`🌐 [Web Image Grabbing] Searching live internet for: "${query}"...`);
  const webPhoto = await searchWebPhotos(query);
  if (webPhoto) return webPhoto;

  // 2. Wikipedia 1080px thumbnail
  const headers = { 'User-Agent': 'YoXoStation/1.0 (https://twitter.com/YoXo_Station; newsroom@yoxo.station)' };
  try {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&generator=search&gsrnamespace=0&gsrlimit=4&piprop=thumbnail&pithumbsize=1080&gsrsearch=${encodeURIComponent(query)}`;
    const res = await fetch(wikiUrl, { headers, timeout: 15000 });
    const data = await res.json();
    if (data.query && data.query.pages) {
      for (const id in data.query.pages) {
        const page = data.query.pages[id];
        if (page.thumbnail && page.thumbnail.source) {
          const rawUrl = page.thumbnail.source;
          console.log(`[1080p Archive Match for '${query}'] ${page.title} (${page.thumbnail.width}x${page.thumbnail.height})`);
          const imgRes = await fetch(rawUrl, { headers, timeout: 18000 });
          if (imgRes.ok) {
            const buf = await imgRes.buffer();
            if (buf.length > 20000) return `data:image/jpeg;base64,${buf.toString('base64')}`;
          }
        }
      }
    }
  } catch (e) {
    console.log(`Wiki search failed for "${query}":`, e.message);
  }

  // 3. Commons 1080px thumbnail
  try {
    const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}&gsrlimit=6&prop=pageimages&piprop=thumbnail&pithumbsize=1080&format=json`;
    const res = await fetch(commonsUrl, { headers, timeout: 15000 });
    const data = await res.json();
    if (data.query && data.query.pages) {
      for (const id in data.query.pages) {
        const page = data.query.pages[id];
        if (page.thumbnail && page.thumbnail.source) {
          const rawUrl = page.thumbnail.source;
          console.log(`[1080p Commons Match for '${query}'] ${page.title}`);
          const imgRes = await fetch(rawUrl, { headers, timeout: 18000 });
          if (imgRes.ok) {
            const buf = await imgRes.buffer();
            if (buf.length > 20000) return `data:image/jpeg;base64,${buf.toString('base64')}`;
          }
        }
      }
    }
  } catch (e) {
    console.log(`Commons search failed for "${query}":`, e.message);
  }

  return null;
}

// 3. Render 1:1 Square Card (Supports both locked-in styles)
async function renderCard({ style, badge, headline, subdeck, photoBase64, sourceName }) {
  let html = '';

  if (style === 'magazine') {
    // Archetype 2: The Magazine Hero (Anton font, mint accents, full photo)
    html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${embeddedFontsCss}
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 1080px; height: 1080px;
    background: #0f1115;
    font-family: 'Plus Jakarta Sans', sans-serif;
    color: #ffffff;
    position: relative;
    overflow: hidden;
  }
  .photo-bg {
    position: absolute;
    top: 0; left: 0;
    width: 1080px; height: 740px;
    background-image: url('${photoBase64}');
    background-size: cover;
    background-position: center 20%;
    filter: contrast(1.06) brightness(0.98);
  }
  .photo-gradient {
    position: absolute;
    top: 0; left: 0;
    width: 1080px; height: 740px;
    background: linear-gradient(
      180deg,
      rgba(15, 17, 21, 0.5) 0%,
      rgba(15, 17, 21, 0.0) 25%,
      rgba(15, 17, 21, 0.2) 55%,
      rgba(15, 17, 21, 0.92) 85%,
      #0f1115 100%
    );
  }
  .masthead {
    position: absolute;
    top: 45px; left: 60px; right: 60px;
    display: flex; justify-content: space-between; align-items: center;
    z-index: 10;
  }
  .source-pill-mag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px; font-weight: 800; letter-spacing: 2px;
    color: #a7f3d0; text-transform: uppercase;
    background: rgba(15, 17, 21, 0.85);
    backdrop-filter: blur(10px);
    padding: 6px 14px; border-radius: 8px;
    border: 1px solid rgba(167, 243, 208, 0.3);
  }
  .brand-tag {
    display: flex; align-items: center; gap: 12px;
    background: rgba(15, 17, 21, 0.85);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 8px 16px 8px 10px;
    border-radius: 12px;
  }
  .brand-tag img { width: 44px; height: 44px; border-radius: 8px; }
  .brand-tag span { font-weight: 800; font-size: 16px; letter-spacing: 0.5px; }

  .content-bottom {
    position: absolute;
    bottom: 50px; left: 60px; right: 60px;
    z-index: 10;
    display: flex; flex-direction: column; gap: 18px;
  }
  .badge-tag {
    background: #a7f3d0;
    color: #064e3b;
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px; font-weight: 800;
    padding: 6px 14px; border-radius: 4px;
    display: inline-block; width: fit-content;
    letter-spacing: 2px; text-transform: uppercase;
  }
  .headline {
    font-family: 'Anton', sans-serif;
    font-size: 74px;
    line-height: 0.95;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .subdeck {
    font-size: 24px; line-height: 1.45;
    color: #cbd5e1; font-weight: 500;
  }
  .footer {
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.15);
  }
  .footer span { font-family: 'JetBrains Mono', monospace; font-size: 14px; color: #64748b; letter-spacing: 2px; }
  .footer .handle { font-family: 'JetBrains Mono', monospace; font-size: 16px; color: #a7f3d0; font-weight: 700; }
</style>
</head>
<body>
  <div class="photo-bg"></div>
  <div class="photo-gradient"></div>
  <div class="masthead">
    <div class="source-pill-mag">LIVE DISPATCH</div>
    <div class="brand-tag">
      <img src="${logoBase64}">
      <span>YoXo Station</span>
    </div>
  </div>
  <div class="content-bottom">
    <div class="badge-tag">${badge || 'BREAKING REPORT'}</div>
    <h1 class="headline">${headline}</h1>
    <p class="subdeck">${subdeck}</p>
    <div class="footer">
      <span>VERIFIED ALERT • YOXO DESK</span>
      <div class="handle">VIA @${(sourceName || 'NEWS DESK').toUpperCase()}</div>
    </div>
  </div>
</body>
</html>`;
  } else {
    // Archetype 1: The Executive Statement Card (JD Vance style)
    html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${embeddedFontsCss}
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: 1080px; height: 1080px;
    background: #0d182e;
    font-family: 'Plus Jakarta Sans', sans-serif;
    color: #ffffff;
    position: relative;
    overflow: hidden;
  }
  .portrait-bg {
    position: absolute;
    top: 0; left: 0;
    width: 1080px; height: 1080px;
    background-image: url('${photoBase64}');
    background-size: cover;
    background-position: center top;
    filter: contrast(1.15) brightness(0.92);
  }
  .gradient-overlay {
    position: absolute;
    top: 0; left: 0;
    width: 1080px; height: 1080px;
    background: linear-gradient(
      180deg,
      rgba(13, 24, 46, 0.4) 0%,
      rgba(13, 24, 46, 0.05) 30%,
      rgba(13, 24, 46, 0.75) 55%,
      rgba(13, 24, 46, 0.98) 78%,
      #0d182e 100%
    );
  }
  .top-bar {
    position: absolute;
    top: 45px; left: 60px; right: 60px;
    display: flex; justify-content: space-between; align-items: center;
    z-index: 10;
  }
  .source-pill {
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px; font-weight: 800; letter-spacing: 2px;
    color: #38bdf8; text-transform: uppercase;
    background: rgba(13, 24, 46, 0.85);
    backdrop-filter: blur(14px);
    padding: 6px 14px; border-radius: 8px;
    border: 1px solid rgba(56, 189, 248, 0.3);
  }
  .brand-pill {
    display: flex; align-items: center; gap: 12px;
    background: rgba(13, 24, 46, 0.85);
    backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 8px 18px 8px 10px;
    border-radius: 14px;
  }
  .brand-pill img { width: 44px; height: 44px; border-radius: 8px; }
  .brand-pill span { font-weight: 800; font-size: 17px; }

  .quote-content {
    position: absolute;
    bottom: 55px; left: 60px; right: 60px;
    z-index: 10;
    display: flex; flex-direction: column; gap: 16px;
    border-left: 5px solid #ef4444;
    padding-left: 28px;
  }
  .quote-marks-row {
    display: flex; align-items: center; gap: 16px;
  }
  .quote-icon {
    font-size: 52px; line-height: 1; font-weight: 900; color: #ffffff;
  }
  .opinion-pill {
    background: #ef4444;
    color: #ffffff;
    font-size: 14px; font-weight: 900;
    letter-spacing: 2.5px;
    padding: 5px 14px;
    border-radius: 4px;
    text-transform: uppercase;
  }
  .opinion-title {
    font-size: 56px;
    font-weight: 900;
    line-height: 1.08;
    letter-spacing: -1px;
    text-transform: uppercase;
  }
  .opinion-body {
    font-size: 23px;
    line-height: 1.45;
    color: #cbd5e1;
    font-weight: 500;
  }
  .footer-row {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 10px;
    padding-top: 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.15);
  }
  .author-tag { font-family: 'JetBrains Mono', monospace; font-size: 15px; color: #94a3b8; font-weight: 700; }
  .handle { font-family: 'JetBrains Mono', monospace; font-size: 16px; color: #38bdf8; font-weight: 800; }
</style>
</head>
<body>
  <div class="portrait-bg"></div>
  <div class="gradient-overlay"></div>
  <div class="top-bar">
    <div class="source-pill">LIVE DISPATCH</div>
    <div class="brand-pill">
      <img src="${logoBase64}">
      <span>YoXo Station</span>
    </div>
  </div>
  <div class="quote-content">
    <div class="quote-marks-row">
      <span class="quote-icon">“</span>
      <span class="opinion-pill">${badge || 'BREAKING INTEL'}</span>
    </div>
    <h1 class="opinion-title">${headline}</h1>
    <p class="opinion-body">${subdeck}</p>
    <div class="footer-row">
      <div class="author-tag">— Verified Market Source</div>
      <div class="handle">VIA @${(sourceName || 'NEWS DESK').toUpperCase()}</div>
    </div>
  </div>
</body>
</html>`;
  }

  const browser = await puppeteer.launch({
    executablePath: getChromeExecutable(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1080,1080']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluateHandle('document.fonts.ready');
  await new Promise(r => setTimeout(r, 200));
  const outputPath = path.resolve(__dirname, 'latest_yoxo_card.png');
  await page.screenshot({ path: outputPath, type: 'png' });
  await browser.close();
  return outputPath;
}

function formatMyanmarTime(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Yangon',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }) + ' MMT';
}

// 4. Send ready-to-copy draft to Telegram with attached clickable info box and 1-Click publish buttons
async function sendDraftToTelegram({ imagePath, tweetCopy, channel, threadId, score, publishedAt, articleUrl }) {
  const draftId = 'd_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const draftsDir = path.resolve(__dirname, 'drafts');
  if (!fs.existsSync(draftsDir)) fs.mkdirSync(draftsDir, { recursive: true });

  const savedImagePath = path.join(draftsDir, `${draftId}.png`);
  try {
    fs.copyFileSync(imagePath, savedImagePath);
  } catch (e) {
    console.error('Failed to cache draft image:', e.message);
  }

  const draftData = {
    id: draftId,
    imagePath: savedImagePath,
    tweetCopy,
    channel,
    threadId,
    score,
    publishedAt,
    articleUrl,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(draftsDir, `${draftId}.json`), JSON.stringify(draftData, null, 2));

  const form = new FormData();
  form.append('chat_id', GROUP_ID);
  if (threadId) {
    form.append('message_thread_id', String(threadId));
  }
  form.append('photo', fs.createReadStream(imagePath));
  
  // Clean copy-paste text only (no header, no footer)
  form.append('caption', tweetCopy);

  // Attached clickable boxes under the post:
  // Row 1: Source Article + Published MMT link
  // Row 2: One-Click Post to Channel & X
  // Row 3: Granular controls (Channel Only, X Only)
  const scoreVal = score ? `${score}/10` : 'Verified';
  const timeMMT = formatMyanmarTime(publishedAt);
  const buttonLabel = timeMMT 
    ? `📊 News Score: ${scoreVal} • 🕒 Published: ${timeMMT} ↗` 
    : `📊 News Score: ${scoreVal} • 🔗 View Source Article ↗`;
  const targetUrl = (articleUrl && articleUrl.startsWith('http')) ? articleUrl : `https://t.me/${channel}`;

  form.append('reply_markup', JSON.stringify({
    inline_keyboard: [
      [
        {
          text: buttonLabel,
          url: targetUrl
        }
      ],
      [
        {
          text: '🚀 1-Click: Post to Channel & X',
          callback_data: `pub_both:${draftId}`
        }
      ],
      [
        {
          text: '📢 Post to Channel',
          callback_data: `pub_tg:${draftId}`
        },
        {
          text: '🐦 Post to X',
          callback_data: `pub_x:${draftId}`
        }
      ]
    ]
  }));

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  return await res.json();
}

async function findViralSourceTweetForQRT(headline, photoPrimary, deskName) {
  try {
    const rawTerms = [photoPrimary, headline].filter(Boolean).join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !['breaking', 'just', 'with', 'from', 'this', 'that', 'about', 'after', 'will', 'have', 'were'].includes(w));

    const terms = Array.from(new Set(rawTerms)).slice(0, 5);
    if (terms.length === 0) return null;

    let targetOutlets = ['IGN', 'Dexerto', 'PopBase', 'Complex', 'CultureCrave', 'DiscussingFilm', 'Variety'];
    if (deskName && deskName.toLowerCase().includes('crypto')) {
      targetOutlets = ['Cointelegraph', 'WatcherGuru', 'CoinDesk', 'WuBlockchain', 'BitcoinMagazine'];
    } else if (deskName && deskName.toLowerCase().includes('politic')) {
      targetOutlets = ['rare_remarks', 'nypost', 'CNN', 'Reuters', 'BBCWorld', 'AP'];
    }

    for (const outlet of targetOutlets) {
      const tweets = await fetchUserTweetsViaSyndication(outlet);
      for (const tw of tweets) {
        const text = (tw.text || '').toLowerCase();
        const matches = terms.filter(t => text.includes(t));
        if (matches.length >= 1) {
          console.log(`🎯 [QRT Prioritizer] Matched viral source tweet from @${outlet} (terms: ${matches.join(', ')}): ${tw.url}`);
          return tw.url;
        }
      }
    }
  } catch (e) {
    console.warn('findViralSourceTweetForQRT notice:', e.message);
  }
  return null;
}

// 5. Main Execution Cycle across all 3 Categorized Desks
async function runCycle() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning sources across all 3 News Desks...`);
  const history = loadHistory();
  let autoPostedXThisCycle = false;

  for (const desk of DESKS) {
    console.log(`\n========================================`);
    console.log(`📂 Checking Desk: [${desk.name.toUpperCase()}] (Thread #${desk.threadId})`);
    console.log(`========================================`);

    let deskPosts = [];
    for (const src of desk.sources) {
      if (src.type === 'telegram') {
        const posts = await fetchChannelPosts(src.channel);
        for (const p of posts) {
          if (!history.includes(p.postId)) {
            deskPosts.push({ ...p, deskName: desk.name, threadId: desk.threadId });
          }
        }
      } else if (src.type === 'rss') {
        const posts = await fetchRSSPosts(src.name, src.url);
        for (const p of posts) {
          if (!history.includes(p.postId)) {
            deskPosts.push({ ...p, deskName: desk.name, threadId: desk.threadId });
          }
        }
      }
    }

    console.log(`Found ${deskPosts.length} fresh unread stories for ${desk.name}.`);

    // Process up to 5 newest stories per desk
    for (const post of deskPosts.slice(-5)) {
      if (desk.name === 'Films and anime') {
        const celebFilter = /\b(welcomes? (a |first )?(baby|child)|gives? birth|pregnant|pregnancy|marries|married|marriage|wedding|dating|divorce|affair|girlfriend|boyfriend|fianc[eé]|personal life|private life)\b/i;
        if (celebFilter.test(post.text)) {
          console.log(`⏩ Skipping celebrity personal gossip for [Films and anime]: "${post.text.slice(0, 60)}..."`);
          history.push(post.postId);
          saveHistory(history);
          continue;
        }

        // Strict filter: Disqualify anime voice actor / character casting announcements
        const isAnimeStory = /anime|animenewsnetwork|crunchyroll|manga|isekai|shonen|otaku/i.test(post.channel + ' ' + post.text);
        const voiceCastFilter = /\b(voice cast(ing)?|casts? (as|for|in)|joins? cast|reprises? role|voice actor|voice actress|va cast|unveils? cast|reveals? cast|seiyuu|character voice)\b/i;
        if (isAnimeStory && voiceCastFilter.test(post.text)) {
          console.log(`⏩ Skipping anime voice casting announcement for [Films and anime]: "${post.text.slice(0, 60)}..."`);
          history.push(post.postId);
          saveHistory(history);
          continue;
        }
      }

      if (desk.name === 'Gaming') {
        const nonGameFilter = /\b(movie|film|box office|theater release|theatrical release|season \d+ (finale|premiere)|disney\+|netflix series|hbo series|sequel brings back)\b/i;
        const hasGameContext = /\b(gameplay|playable|console|playstation|ps5|xbox|nintendo|switch|steam|pc game|rpg|fps|esports|patch|dlc|remake|multiplayer|studios?|valve|rockstar|ubisoft|blizzard|capcom|bethesda|videogame|video game)\b/i;
        if (nonGameFilter.test(post.text) && !hasGameContext.test(post.text)) {
          console.log(`⏩ Skipping non-game movie/series story for [Gaming]: "${post.text.slice(0, 60)}..."`);
          history.push(post.postId);
          saveHistory(history);
          continue;
        }
      }

      console.log(`\nReviewing [${desk.name}] from @${post.channel}: "${post.text.slice(0, 60)}..."`);
      try {
        const analysis = await analyzeNewsWithGemini(post.text, desk.name);
        console.log(`-> Score: ${analysis.score}/10 | Keep: ${analysis.is_interesting} | Reason: ${analysis.reason}`);

        // Mark as seen so we never re-evaluate
        history.push(post.postId);
        saveHistory(history);

        if (analysis.is_duplicate) {
          console.log(`⏩ Skipping duplicate story detected by AI: "${post.text.slice(0, 50)}..."`);
          continue;
        }

        if (analysis.is_interesting && analysis.score >= 8) {
          console.log(`🚨 BREAKING STORY DETECTED FOR [${desk.name}]! Preparing graphic & draft...`);

          // 1. Graphic headline: pure headline only (no "JUST IN:" or "BREAKING:" on graphic)
          let cleanHeadline = (analysis.card_headline || '')
            .replace(/^((JUST IN|BREAKING)[:\s\-\–]+)/i, '')
            .trim()
            .toUpperCase();

          // Cross-source semantic deduplication
          if (isDuplicateStory(cleanHeadline)) {
            console.log(`⏩ Skipping duplicate story for [${desk.name}]: "${cleanHeadline}"`);
            continue;
          }

          let photoBase64 = '';

          // Priority 1: Direct Editorial Photo from the Source / Webpage (100% Exact Context Match)
          console.log(`🖼️ [Photo Grabbing] Priority 1: Extracting official editorial photo from source...`);
          photoBase64 = await getSourceEditorialPhoto(post);

          // Priority 2: Web Image Search Across the Entire Internet for Central Subject
          if (!photoBase64 && analysis.photo_primary) {
            console.log(`🌐 [Photo Grabbing] Priority 2: Searching live web for central subject: "${analysis.photo_primary}"...`);
            photoBase64 = await fetchSmartPhoto(analysis.photo_primary);
            if (photoBase64) {
              console.log(`✅ Loaded live web photo for: "${analysis.photo_primary}"!`);
            }
          }

          // Priority 3: Web Image Search for Full Contextual Story (Subject + Headline Keywords)
          if (!photoBase64) {
            const contextTerms = [
              analysis.photo_primary,
              cleanHeadline.toLowerCase(),
              desk.name.toLowerCase().includes('politic') ? 'politics' : '',
              desk.name.toLowerCase().includes('disaster') ? 'disaster' : ''
            ].filter(Boolean).join(' ');
            console.log(`🌐 [Photo Grabbing] Priority 3: Searching live web for full contextual story: "${contextTerms}"...`);
            photoBase64 = await fetchSmartPhoto(contextTerms);
            if (photoBase64) {
              console.log(`✅ Loaded live web photo for: "${contextTerms}"!`);
            }
          }

          // Priority 4: Web Search for Contextual Setting
          if (!photoBase64 && analysis.photo_fallback) {
            console.log(`🌐 [Photo Grabbing] Priority 4: Searching contextual setting: "${analysis.photo_fallback}"...`);
            photoBase64 = await fetchSmartPhoto(analysis.photo_fallback);
            if (photoBase64) {
              console.log(`✅ Loaded contextual photo for: "${analysis.photo_fallback}"!`);
            }
          }

          // Priority 5: Relevant Desk Fallback Asset (Strictly Desk-Isolated)
          if (!photoBase64) {
            console.log(`🖼️ [Photo Fallback] Loading dedicated asset library for [${desk.name}]...`);
            let deskFolder = 'politics';
            if (desk.name === 'Web3 & Crypto') deskFolder = 'crypto';
            else if (desk.name === 'International Disasters') deskFolder = 'disasters';
            else if (desk.name === 'Gaming') deskFolder = 'gaming';
            else if (desk.name === 'Films and anime') deskFolder = 'films';
            else if (desk.name === 'Entertainments') deskFolder = 'entertainments';
            else if (desk.name === 'MUST POST') deskFolder = 'politics';

            const dir = path.resolve(__dirname, 'assets', deskFolder);
            const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jpg') || f.endsWith('.png')) : [];
            if (files.length > 0) {
              let chosenFile = files[Math.floor(Math.random() * files.length)];
              const fullStory = `${post.text} ${analysis.card_headline}`.toLowerCase();
              if (deskFolder === 'politics') {
                if (fullStory.includes('poll') || fullStory.includes('vote') || fullStory.includes('voter') || fullStory.includes('ballot') || fullStory.includes('election')) {
                  const ballotPick = files.find(f => f.includes('voting') || f.includes('ballot'));
                  if (ballotPick) chosenFile = ballotPick;
                } else if (fullStory.includes('white house') || fullStory.includes('biden') || fullStory.includes('trump')) {
                  const whPick = files.find(f => f.includes('white_house'));
                  if (whPick) chosenFile = whPick;
                } else if (fullStory.includes('congress') || fullStory.includes('senate') || fullStory.includes('house') || fullStory.includes('capitol')) {
                  const capPick = files.find(f => f.includes('capitol'));
                  if (capPick) chosenFile = capPick;
                }
              }
              const fullPath = path.resolve(dir, chosenFile);
              console.log(`✅ Selected dedicated [${desk.name}] fallback photo: ${chosenFile}`);
              photoBase64 = `data:image/jpeg;base64,${fs.readFileSync(fullPath).toString('base64')}`;
            } else {
              const fallback = path.resolve(__dirname, 'assets', 'executive_suit.jpg');
              photoBase64 = `data:image/jpeg;base64,${fs.readFileSync(fallback).toString('base64')}`;
            }
          }

          // Alternate graphic style strictly between Magazine and Opinion
          const activeStyle = getNextCardStyle();
          console.log(`🎨 Alternating Graphic Archetype: [${activeStyle.toUpperCase()}]`);

          const imagePath = await renderCard({
            style: activeStyle,
            badge: analysis.category_pill,
            headline: cleanHeadline,
            subdeck: analysis.card_subdeck,
            photoBase64,
            sourceName: post.channel
          });

          // 3. Clean emojis and strip trailing duplicate question from tweetCopy
          let cleanTweet = (analysis.tweet_copy || '')
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
            .replace(/[^\S\r\n]+/g, ' ')
            .trim();
          cleanTweet = cleanTweet.replace(/\?\s*(Where do you stand\?|What are your thoughts\?|Which side are you on\?|Who is right\?|Thoughts\?)\s*$/i, '?');

          console.log(`Dispatching draft to [${desk.name}] topic (Thread #${desk.threadId})...`);
          const tgRes = await sendDraftToTelegram({
            imagePath,
            tweetCopy: cleanTweet,
            channel: post.channel,
            threadId: desk.threadId,
            score: analysis.score,
            publishedAt: post.publishedAt,
            articleUrl: post.url || post.postId
          });

          if (tgRes.ok) {
            console.log(`✅ Sent successfully to [${desk.name}]!`);
            saveHeadline(cleanHeadline);

            // 100% Autopilot Publishing to X and Telegram Channel for top breaking stories (score >= 8 or MUST POST)
            if (!autoPostedXThisCycle && (analysis.score >= 8 || analysis.is_must_post)) {
              if (canPostToX(analysis.is_must_post)) {
                autoPostedXThisCycle = true;

                // 1. Auto-publish directly to Telegram Channel @yoxo_station
                try {
                  console.log(`📢 [AUTOPILOT] Auto-publishing breaking story to Telegram Channel [@yoxo_station]...`);
                  const form = new FormData();
                  form.append('chat_id', CHANNEL_ID);
                  form.append('photo', fs.createReadStream(imagePath));
                  form.append('caption', cleanTweet);
                  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
                  console.log(`✅ [AUTOPILOT] Published to Telegram Channel!`);
                } catch (e) {
                  console.error('Channel auto-publish error:', e.message);
                }

                // 2. Auto-publish directly to X (@YoXo_Station) via authenticated session (Clean standalone post)
                if (fs.existsSync(path.resolve(__dirname, 'x_session.json'))) {
                  try {
                    console.log(`🚀 [AUTOPILOT] Auto-publishing breaking story to X (@YoXo_Station)...`);
                    const quoteUrl = null; // Strictly no quote tweets as requested

                    const xRes = await postToX({ imagePath, text: cleanTweet, quoteUrl });
                    if (xRes && xRes.ok) {
                      console.log(`✅ [AUTOPILOT] Successfully published standalone post to X (@YoXo_Station)!`);
                      recordXPost(cleanHeadline, post.url);
                    } else {
                      console.warn(`X auto-publish note:`, xRes ? xRes.error : 'skipped');
                    }

                    // Top-Reply Sniper: If story originated from a viral X post, place an organic, human insider comment
                    if (quoteUrl && canCommentOnX() && !hasAlreadyCommented(quoteUrl) && isWithinCommentRecencyWindow(post.publishedAt)) {
                      console.log(`🎯 [AUTOPILOT] Crafting organic human reply for viral tweet: ${quoteUrl}...`);
                      const humanComment = await generateHumanReply(post.text) || cleanHeadline;
                      const replyRes = await replyToTweetOnX({
                        tweetUrl: quoteUrl,
                        replyText: humanComment
                      });
                      if (replyRes && replyRes.ok) {
                        recordXComment(quoteUrl, humanComment);
                        console.log(`✅ [AUTOPILOT] Successfully placed organic comment on viral tweet!`);
                      }
                    }
                  } catch (e) {
                    console.error('X auto-publish error:', e.message);
                  }
                }
              }
            }

            break; // Send 1 high quality story per desk per cycle
          } else {
            console.error(`Telegram send failed:`, tgRes);
          }
        }
      } catch (err) {
        console.error('Error on story:', err.message);
      }
    }
  }

  // Autonomous Multi-Source X Comment Explorer (Feed scroll + top crypto/news sources every 10-15 mins)
  try {
    if (canCommentOnX()) {
      await autoCommentOnXFeedOrOutlets();
    }
  } catch (err) {
    console.warn('X Comment Explorer notice:', err.message);
  }
}

const OUTLETS_TO_SCAN = [
  'CultureCrave',
  'DiscussingFilm',
  'IGN',
  'GameSpot',
  'Kotaku',
  'Dexerto',
  'PopBase',
  'PopCrave',
  'Complex',
  'Cointelegraph',
  'nypost',
  'CNN',
  'rare_remarks',
  'ScreenRant',
  'Variety',
  'DEADLINE',
  'WuBlockchain',
  'CoinDesk',
  'unusual_whales',
  'WatcherGuru',
  'TechCrunch',
  'TheVerge',
  'WIRED',
  'BBCWorld',
  'Reuters',
  'AP',
  'BitcoinMagazine'
];

async function fetchUserTweetsViaSyndication(username) {
  try {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const entries = data?.props?.pageProps?.timeline?.entries || [];
    
    return entries.map(e => {
      const tw = e.content?.tweet;
      if (!tw) return null;
      return {
        id: tw.id_str,
        url: `https://x.com/${username}/status/${tw.id_str}`,
        text: tw.full_text || '',
        createdAt: tw.created_at,
        user: username
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function discoverAndCommentOnX(maxComments = 1) {
  const SESSION_FILE = path.resolve(__dirname, 'x_session.json');
  if (!fs.existsSync(SESSION_FILE)) return 0;
  console.log(`🌐 [X Explorer] Scanning live feeds across diverse gaming, culture, tech & crypto outlets (Target: ${maxComments} replies)...`);

  try {
    // Unrestricted outlet rotation across gaming, culture, tech, macro, crypto, world news
    const outletsToScan = [...OUTLETS_TO_SCAN].sort(() => 0.5 - Math.random());
    console.log(`🌐 [X Explorer] Outlets for scanning: ${outletsToScan.join(', ')}...`);

    let allTweets = [];
    let scannedCount = 0;
    for (const acc of outletsToScan) {
      const list = await fetchUserTweetsViaSyndication(acc);
      if (list && list.length > 0) {
        allTweets = allTweets.concat(list);
      }
      scannedCount++;

      // Only stop scanning early if we actually have enough candidate tweets under 2 hours old!
      const freshUnder2h = allTweets.filter(tw => {
        if (!tw.url || hasAlreadyCommented(tw.url) || tw.text.startsWith('RT @')) return false;
        const ageMins = (Date.now() - new Date(tw.createdAt).getTime()) / 60000;
        return ageMins >= 1 && ageMins <= 120;
      });
      if (freshUnder2h.length >= 5 && scannedCount >= 8) break;

      await new Promise(r => setTimeout(r, 400));
    }
    console.log(`🌐 [X Explorer] Retrieved ${allTweets.length} live tweets across outlets.`);

    // Find the freshest tweets (1m - 24h fallback, sorted freshest first)
    const now = Date.now();
    const validTweets = allTweets.filter(tw => {
      if (!tw.url || !tw.text || tw.text.length < 10) return false;
      if (tw.text.startsWith('RT @')) return false;
      if (hasAlreadyCommented(tw.url)) return false;
      return true;
    });

    const candidates = validTweets.map(tw => ({
      ...tw,
      ageMins: Math.round((now - new Date(tw.createdAt).getTime()) / 60000)
    })).filter(tw => tw.ageMins >= 1 && tw.ageMins <= 120) // Strictly within the last 2 hours (under 120m)
      .sort((a, b) => a.ageMins - b.ageMins);

    if (!candidates || candidates.length === 0) {
      console.log('🌐 [X Explorer] No candidate tweet found under 2 hours old this cycle.');
      return 0;
    }

    let placed = 0;
    for (const candidate of candidates) {
      if (placed >= maxComments) break;

      console.log(`🎯 [X Explorer] Selected target from @${candidate.user} (${candidate.ageMins}m ago): ${candidate.url}`);
      console.log(`Original Text: "${candidate.text.slice(0, 80)}..."`);

      const humanComment = await generateHumanReply(candidate.text);
      if (!humanComment) continue;

      console.log(`💬 [X Explorer] Generated Comment: "${humanComment}"`);
      const replyRes = await replyToTweetOnX({
        tweetUrl: candidate.url,
        replyText: humanComment
      });

      if (replyRes && replyRes.ok) {
        recordXComment(candidate.url, humanComment);
        placed++;
        console.log(`✅ [X Explorer] Successfully placed top comment (${placed}/${maxComments}) under post!`);
        if (placed < maxComments) {
          const waitMins = 3 + Math.random() * 2; // Strict 3 to 5 mins wait
          console.log(`⏳ [Pacing Rhythm] Chilling for ${waitMins.toFixed(1)} minutes (3-5m pacing) before engaging with next post...`);
          await new Promise(r => setTimeout(r, waitMins * 60 * 1000));
        }
      } else {
        console.warn('X Explorer reply error:', replyRes ? replyRes.error : 'unknown');
      }
    }
    return placed;
  } catch (err) {
    console.warn('X Explorer notice:', err.message);
    return 0;
  }
}

async function browseFeedAndCommentOnX(targetCommentsCount = 4) {
  const SESSION_FILE = path.resolve(__dirname, 'x_session.json');
  if (!fs.existsSync(SESSION_FILE)) return 0;

  console.log('🌐 [Feed Explorer] Navigating to your live X home timeline...');
  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const executablePath = await getChromeExecutable();

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,1000'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    const rawUa = await page.evaluate(() => navigator.userAgent);
    const cleanUa = rawUa.replace('HeadlessChrome', 'Chrome');
    await page.setUserAgent(cleanUa);
    await page.setCookie(...cookies);

    console.log('🌐 [Feed Explorer] Loading x.com/home...');
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(e => console.log('Feed goto notice:', e.message));
    console.log(`🌐 [Feed Explorer] Landed on: ${page.url()} | Title: ${await page.title()}`);
    await dismissCookieBanner(page);
    
    // Dismiss any modal dialogs (notifications, popups, etc.)
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      for (const b of buttons) {
        if (b.innerText && (b.innerText === 'Not now' || b.innerText === 'Dismiss' || b.innerText === 'Maybe later' || b.innerText === 'Got it')) {
          b.click();
        }
      }
    });

    // Wait for timeline tweets to mount and render
    try {
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 });
      console.log('✅ [Feed Explorer] Timeline tweets rendered successfully!');
    } catch (e) {
      console.log('Feed timeline wait note:', e.message);
    }
    await new Promise(r => setTimeout(r, 1500));

    // Click "See new posts" pill if visible to reveal latest timeline posts
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('div[role="button"], span, button')).find(el => el.innerText && el.innerText.includes('See new posts'));
      if (btn) btn.click();
    });

    // Incremental scroll & scrape: capture tweets at each scroll step before virtualizer unmounts them
    console.log('📜 [Feed Explorer] Incrementally scrolling timeline to capture all creator & news posts...');
    const tweetMap = new Map();

    async function scrapeVisibleTweets() {
      const visible = await page.evaluate(() => {
        const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
        return articles.map(a => {
          const linkElem = a.querySelector('a[href*="/status/"]');
          const textElem = a.querySelector('div[data-testid="tweetText"]');
          const userElem = a.querySelector('div[data-testid="User-Name"]');
          const timeElem = a.querySelector('time');

          let rawUrl = linkElem ? linkElem.getAttribute('href') : null;
          if (rawUrl) {
            rawUrl = rawUrl.split('?')[0].replace(/\/analytics$/, '');
            if (!rawUrl.startsWith('http')) rawUrl = 'https://x.com' + rawUrl;
          }

          return {
            user: userElem?.innerText.replace(/\n/g, ' ') || '',
            text: textElem?.innerText.trim() || '',
            url: rawUrl,
            time: timeElem?.getAttribute('datetime')
          };
        });
      });

      for (const t of visible) {
        if (t.url && !tweetMap.has(t.url)) {
          tweetMap.set(t.url, t);
        }
      }
    }

    // Capture initial visible posts
    await scrapeVisibleTweets();

    // Scroll 14 times, capturing new posts as they appear
    for (let s = 0; s < 14; s++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await new Promise(r => setTimeout(r, 700));
      await scrapeVisibleTweets();
    }

    await browser.close();
    browser = null;

    const rawTweets = Array.from(tweetMap.values());
    console.log(`📊 [Feed Explorer] Extracted ${rawTweets.length} unique tweets directly from your live feed.`);

    const now = Date.now();
    const candidates = rawTweets.filter(t => {
      if (!t.url || !t.text || t.text.length < 10) return false;
      if (/^(https?:\/\/|www\.)\S+$/i.test(t.text.trim())) return false; // skip bare links
      if (hasAlreadyCommented(t.url)) return false;
      if (t.text.startsWith('RT @')) return false;

      let ageMins = 15;
      if (t.time) {
        ageMins = (now - new Date(t.time).getTime()) / 60000;
        if (ageMins > 120 || ageMins < -10) return false; // Strictly max 2 hours (120m) old, allowing brand-new posts
      }
      t.ageMins = Math.max(0, Math.round(ageMins));
      return true;
    });

    if (!candidates || candidates.length === 0) {
      console.log('🌐 [Feed Explorer] No unreplied candidate found under 2 hours old directly on home feed.');
      return 0;
    }

    // Prioritize freshest posts first for maximum reply visibility
    const prioritizedCandidates = candidates.sort((a, b) => a.ageMins - b.ageMins);
    let commentsPlaced = 0;

    for (const target of prioritizedCandidates) {
      if (commentsPlaced >= targetCommentsCount) break;

      console.log(`🎯 [Feed Explorer] Selected feed post from ${target.user}: ${target.url}`);
      console.log(`Original Text: "${target.text.slice(0, 80)}..."`);

      const humanComment = await generateHumanReply(target.text);
      if (!humanComment) {
        console.log(`⏩ Skipping post (could not verify high-context alignment).`);
        continue;
      }

      console.log(`💬 [Feed Explorer] Thoughtful Comment: "${humanComment}"`);
      const replyRes = await replyToTweetOnX({
        tweetUrl: target.url,
        replyText: humanComment
      });

      if (replyRes && replyRes.ok) {
        recordXComment(target.url, humanComment);
        commentsPlaced++;
        console.log(`✅ [Feed Explorer] Successfully placed Reply under post (${commentsPlaced}/${targetCommentsCount})!`);
        
        if (commentsPlaced < targetCommentsCount) {
          const waitMins = 3 + Math.random() * 2; // Strict 3 to 5 mins wait
          console.log(`⏳ [Pacing Rhythm] Chilling for ${waitMins.toFixed(1)} minutes (3-5m pacing) before engaging with next post...`);
          await new Promise(r => setTimeout(r, waitMins * 60 * 1000));
        }
      } else {
        console.warn('Feed Explorer reply note:', replyRes ? replyRes.error : 'unknown');
      }
    }

    return commentsPlaced;
  } catch (err) {
    console.warn('Feed Explorer notice:', err.message);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    return 0;
  }
}

async function autoCommentOnXFeedOrOutlets() {
  const TARGET_TOTAL_COMMENTS = 3; // Active continuous 3-5 min rhythm (3 thoughtful comments per cycle)
  console.log(`🎯 [Pacing Rhythm] Commencing commenting cycle (targeting up to ${TARGET_TOTAL_COMMENTS} thoughtful replies, max 2h old)...`);

  // Priority 1: Direct Home Feed Deep Scroll (Personal algorithm & following creators across all fields)
  let feedCount = 0;
  try {
    feedCount = await browseFeedAndCommentOnX(TARGET_TOTAL_COMMENTS);
  } catch (e) {
    console.warn('Feed Explorer error:', e.message);
  }

  // Priority 2: If feed had fewer than target comments, immediately fulfill remaining comments so there is NEVER a gap!
  const remainingNeeded = TARGET_TOTAL_COMMENTS - (feedCount || 0);
  if (remainingNeeded > 0) {
    if (feedCount > 0) {
      const waitMins = 3 + Math.random() * 2; // Strict 3 to 5 mins wait
      console.log(`⏳ [Pacing Rhythm] Chilling for ${waitMins.toFixed(1)} minutes before engaging next post...`);
      await new Promise(r => setTimeout(r, waitMins * 60 * 1000));
    }
    console.log(`🔄 Engaging diversified live posts for ${remainingNeeded} reply/replies with 3-5 min pacing...`);
    await discoverAndCommentOnX(remainingNeeded);
  }
}

// 6. Interactive Telegram 1-Click Callback Listener
let lastUpdateOffset = 0;

async function startTelegramCallbackListener() {
  console.log('👂 Telegram 1-click callback listener active...');
  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateOffset}&timeout=25`, {
        timeout: 35000
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          lastUpdateOffset = update.update_id + 1;
          if (update.callback_query) {
            handleCallbackQuery(update.callback_query).catch(err => console.error('Callback error:', err));
          }
        }
      }
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function handleCallbackQuery(cq) {
  const queryId = cq.id;
  const data = cq.data || '';
  const message = cq.message;
  const chatId = message ? message.chat.id : null;
  const messageId = message ? message.message_id : null;

  console.log(`🔘 Received callback click: [${data}] from ${cq.from ? (cq.from.first_name || cq.from.username || 'User') : 'User'}`);

  if (!data.startsWith('pub_')) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: queryId, text: 'Action received' })
    });
    return;
  }

  const [action, draftId] = data.split(':');
  const draftFile = path.resolve(__dirname, 'drafts', `${draftId}.json`);

  let caption = (message && message.caption) ? message.caption : '';
  let photoFileId = (message && message.photo && message.photo.length) ? message.photo[message.photo.length - 1].file_id : null;
  let localImagePath = null;

  if (fs.existsSync(draftFile)) {
    try {
      const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
      if (draft.tweetCopy) caption = draft.tweetCopy;
      if (draft.imagePath && fs.existsSync(draft.imagePath)) localImagePath = draft.imagePath;
    } catch (e) {}
  }

  // If neither photoFileId nor localImagePath exists, then and only then is it missing
  if (!photoFileId && !localImagePath) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: queryId, text: 'Draft photo not found', show_alert: true })
    });
    return;
  }

  // Immediate toast feedback
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: queryId, text: 'Publishing in progress...' })
  });

  let tgSuccess = false;
  let xSuccess = false;

  // 1. Post to Telegram Channel (@yoxo_station)
  if (action === 'pub_both' || action === 'pub_tg') {
    try {
      console.log(`📢 Dispatching to Telegram Channel [${CHANNEL_ID}]...`);
      let tgRes;
      if (photoFileId) {
        // Direct instant publish via Telegram CDN file_id (no disk lookup needed!)
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            photo: photoFileId,
            caption: caption
          })
        });
        tgRes = await res.json();
      } else if (localImagePath) {
        const form = new FormData();
        form.append('chat_id', CHANNEL_ID);
        form.append('photo', fs.createReadStream(localImagePath));
        form.append('caption', caption);
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST',
          body: form
        });
        tgRes = await res.json();
      }

      if (tgRes && tgRes.ok) {
        tgSuccess = true;
        console.log('✅ Published to Telegram Channel @yoxo_station!');
      } else {
        console.error('Telegram channel publish failed:', tgRes);
      }
    } catch (err) {
      console.error('Error posting to channel:', err.message);
    }
  }

  // 2. Post to X
  if (action === 'pub_both' || action === 'pub_x') {
    try {
      console.log('🐦 Dispatching to X (@YoXo_Station)...');
      if (!localImagePath && photoFileId) {
        try {
          const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photoFileId}`);
          const fileData = await fileRes.json();
          if (fileData.ok && fileData.result.file_path) {
            const dlUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
            const imgRes = await fetch(dlUrl);
            const buf = await imgRes.buffer();
            const draftsDir = path.resolve(__dirname, 'drafts');
            if (!fs.existsSync(draftsDir)) fs.mkdirSync(draftsDir, { recursive: true });
            localImagePath = path.join(draftsDir, `${draftId}.png`);
            fs.writeFileSync(localImagePath, buf);
          }
        } catch (e) {
          console.error('Failed to download photo from TG CDN for X:', e.message);
        }
      }
      const xRes = await postToX({ imagePath: localImagePath, text: caption });
      if (xRes && xRes.ok) {
        xSuccess = true;
        console.log('✅ Published to X (@YoXo_Station)!');
      } else {
        console.warn('X publish notice:', xRes ? xRes.error : 'failed');
      }
    } catch (err) {
      console.error('Error posting to X:', err.message);
    }
  }

  // 3. Update original draft message buttons with confirmation stamp
  const nowMMT = formatMyanmarTime(new Date()) || 'Just now';
  let statusText = '✅ Published!';
  if (action === 'pub_both') {
    statusText = `✅ Published to Channel & X (${nowMMT})`;
  } else if (action === 'pub_tg') {
    statusText = `✅ Published to Channel (${nowMMT})`;
  } else if (action === 'pub_x') {
    statusText = `✅ Published to X (${nowMMT})`;
  }

  // Preserve article link button
  const existingButtons = (message && message.reply_markup && message.reply_markup.inline_keyboard) || [];
  const topRow = existingButtons[0] || [];

  const updatedMarkup = {
    inline_keyboard: [
      topRow,
      [
        { text: statusText, callback_data: `noop:${draftId}` }
      ]
    ]
  };

  if (chatId && messageId) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: updatedMarkup
      })
    });
  }
}

// 7. Keep-alive HTTP Server for Cloud Hosting (Render / Koyeb)
let server = null;
function startServer() {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'active', newsroom: 'YoXo Station', uptime: process.uptime() }));
  });
  server.listen(PORT, () => {
    console.log(`🌐 YoXo Keep-alive server listening on port ${PORT}`);
  });
}

// Run single cycle or continuous autonomous daemon
if (require.main === module) {
  startServer();
  if (process.argv.includes('--daemon')) {
    console.log('🚀 YoXo Autonomous Newsroom Daemon started! Monitoring all 7 desks every 15 minutes.');
    startTelegramCallbackListener();
    runCycle().catch(console.error);
    setInterval(() => {
      runCycle().catch(console.error);
    }, 15 * 60 * 1000);
  } else {
    // Single cycle mode (used by GitHub Actions cron) - runs once and exits cleanly
    runCycle().then(() => {
      console.log('🏁 Single cycle finished successfully.');
      if (server) server.close();
      process.exit(0);
    }).catch(err => {
      console.error('Fatal cycle error:', err);
      process.exit(1);
    });
  }
}

module.exports = {
  runCycle,
  browseFeedAndCommentOnX,
  autoCommentOnXFeedOrOutlets,
  discoverAndCommentOnX,
  generateHumanReply,
  canPostToX,
  canCommentOnX,
  recordXPost,
  recordXComment
};
