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

async function insertTweetText(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 20000 });
  await page.click(selector);

  // Clean empty character
  await page.keyboard.sendCharacter('');

  // Use clipboard DataTransfer event in the browser first (most native, preserves all formatting)
  const success = await page.evaluate((sel, content) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', content);
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      el.dispatchEvent(ev);
      const current = el.innerText || el.textContent || '';
      return current.trim().length >= 10;
    } catch (e) {
      return false;
    }
  }, selector, text);

  // Fallback if clipboard paste didn't populate: type line by line with Shift+Enter
  if (!success) {
    console.log('⌨️ Typing formatted tweet copy line-by-line...');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        await page.keyboard.type(lines[i], { delay: 5 });
      }
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
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

    // Find the inline reply box under the tweet and insert text cleanly
    const replySelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await insertTweetText(page, replySelector, replyText);

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

    // Click the inline Reply button
    console.log('🚀 Dispatching Top Reply comment...');
    const replyButton = 'div[data-testid="tweetButtonInline"], button[data-testid="tweetButtonInline"]';
    await page.waitForSelector(replyButton, { timeout: 10000 });
    await page.click(replyButton);

    await new Promise(r => setTimeout(r, 4000));
    console.log('✅ Successfully placed Top Reply on viral thread!');

    await browser.close();
    return { ok: true };
  } catch (err) {
    console.error('❌ Failed to reply on X:', err.message);
    try { await browser.close(); } catch(e) {}
    return { ok: false, error: err.message };
  }
}

module.exports = { postToX, replyToTweetOnX };
