const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.resolve(__dirname, 'x_session.json');

async function getChromeExecutable() {
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

async function dismissCookieBanner(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const dismissed = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, div[role="button"], span'));
        for (const el of all) {
          if (el.innerText && (el.innerText.includes('Accept all cookies') || el.innerText.includes('Refuse non-essential'))) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (dismissed) {
        console.log('✅ Dismissed X cookie banner.');
        await new Promise(r => setTimeout(r, 1500));
        return true;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1200));
  }
  return false;
}

async function insertTweetText(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 20000 });
  await page.click(selector);
  await new Promise(r => setTimeout(r, 600));

  // Clear any existing draft text
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await new Promise(r => setTimeout(r, 600));

  // Type line-by-line using Shift+Enter for clean paragraph formatting without duplicate paste bugs
  console.log('⌨️ Typing clean formatted copy...');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      await page.keyboard.type(lines[i], { delay: 10 });
    }
    if (i < lines.length - 1) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

// 1. Post Standalone Tweet or Quote Tweet (QRT)
async function postToX({ imagePath, text, quoteUrl }) {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error('⚠️ No x_session.json found! Please run node x_login.js first to log in.');
    return { ok: false, error: 'No X session found. Please log in first.' };
  }

  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const executablePath = await getChromeExecutable();

  console.log('🐦 Initializing X poster in background...');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie(...cookies);

    // If quoteUrl provided, navigate to compose with embedded quote URL
    let targetUrl = 'https://x.com/compose/post';
    let fullText = text;
    if (quoteUrl && (quoteUrl.includes('x.com/') || quoteUrl.includes('twitter.com/'))) {
      console.log(`⚡ [QRT Mode] Formatting as Quote Tweet for: ${quoteUrl}`);
      fullText = `${text}\n\n${quoteUrl}`;
    }

    console.log('🐦 Opening X composer...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    // Verify logged in
    if (page.url().includes('/i/flow/login') || page.url().includes('/login')) {
      console.error('⚠️ X session expired or logged out.');
      await browser.close();
      return { ok: false, error: 'X session expired. Please re-login.' };
    }

    // Insert full formatted copy with newlines & bullet points
    const textSelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await insertTweetText(page, textSelector, fullText);

    // Attach image if provided
    if (imagePath && fs.existsSync(imagePath)) {
      console.log('📸 Attaching editorial graphic to tweet...');
      try {
        await page.waitForSelector('input[type="file"][data-testid="fileInput"]', { timeout: 8000 });
        const fileInput = await page.$('input[type="file"][data-testid="fileInput"]');
        if (fileInput) {
          await fileInput.uploadFile(imagePath);
          await new Promise(r => setTimeout(r, 3500));
        }
      } catch (e) {
        console.warn('Image upload selector warning:', e.message);
      }
    }

    // Click Tweet Post button
    console.log('🚀 Clicking Tweet button...');
    const postButtonSelector = 'div[data-testid="tweetButton"], button[data-testid="tweetButtonInline"], div[data-testid="tweetButtonInline"], [data-testid="tweetButton"]';
    await page.waitForSelector(postButtonSelector, { timeout: 12000 });
    await page.click(postButtonSelector);

    // Wait for tweet to dispatch
    await new Promise(r => setTimeout(r, 4500));
    console.log('✅ Successfully published to X (@YoXo_Station)!');

    await browser.close();
    return { ok: true, isQrt: !!quoteUrl };
  } catch (err) {
    console.error('❌ Failed to post to X:', err.message);
    try { await browser.close(); } catch(e) {}
    return { ok: false, error: err.message };
  }
}

// 2. Top-Reply / Comment Sniper directly under viral tweets
async function replyToTweetOnX({ tweetUrl, imagePath, replyText }) {
  if (!fs.existsSync(SESSION_FILE)) {
    return { ok: false, error: 'No X session found.' };
  }

  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const executablePath = await getChromeExecutable();

  console.log(`🎯 [Reply Sniper] Navigating to viral tweet: ${tweetUrl}...`);
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie(...cookies);

    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await dismissCookieBanner(page);

    // Determine if inline composer is available or open modal reply dialog
    let replyTextarea = null;
    let replySubmitBtn = null;

    // Check if inline reply composer is present on the status page
    const inlineComposer = await page.$('div[data-testid="Inline-Composer"], div[data-testid="tweetTextarea_0"]');
    const inlineSubmit = await page.$('[data-testid="tweetButtonInline"]');

    if (inlineComposer && inlineSubmit) {
      console.log('Found inline reply composer under tweet.');
      replyTextarea = 'div[data-testid="tweetTextarea_0"]';
      replySubmitBtn = '[data-testid="tweetButtonInline"]';
    } else {
      console.log('Inline composer not ready, opening modal reply dialog via tweet reply button...');
      const replyIcon = 'article[data-testid="tweet"] [data-testid="reply"]';
      await page.waitForSelector(replyIcon, { timeout: 10000 });
      await page.click(replyIcon);
      await new Promise(r => setTimeout(r, 1200));

      // Wait for modal dialog
      await page.waitForSelector('div[role="dialog"] div[data-testid="tweetTextarea_0"]', { timeout: 10000 });
      replyTextarea = 'div[role="dialog"] div[data-testid="tweetTextarea_0"]';
      replySubmitBtn = 'div[role="dialog"] [data-testid="tweetButton"]';
    }

    console.log(`Writing reply copy using ${replyTextarea}...`);
    await insertTweetText(page, replyTextarea, replyText);

    // Attach 1080p visual card if present
    if (imagePath && fs.existsSync(imagePath)) {
      try {
        const fileInput = await page.$('input[type="file"][data-testid="fileInput"]');
        if (fileInput) {
          await fileInput.uploadFile(imagePath);
          await new Promise(r => setTimeout(r, 3000));
        }
      } catch (e) {}
    }

    // Click the strict Reply button (strictly inside modal or inline composer)
    console.log(`🚀 Dispatching Reply comment via ${replySubmitBtn}...`);
    await page.waitForSelector(replySubmitBtn, { timeout: 10000 });
    await page.click(replySubmitBtn);

    await new Promise(r => setTimeout(r, 4500));
    console.log('✅ Successfully placed Reply under target post!');

    await browser.close();
    return { ok: true };
  } catch (err) {
    console.error('❌ Failed to reply on X:', err.message);
    try { await browser.close(); } catch(e) {}
    return { ok: false, error: err.message };
  }
}

module.exports = { postToX, replyToTweetOnX, getChromeExecutable, dismissCookieBanner };
