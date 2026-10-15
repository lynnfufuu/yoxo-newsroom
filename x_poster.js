const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.resolve(__dirname, 'x_session.json');

async function getChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

async function postToX({ imagePath, text }) {
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

    console.log('🐦 Opening X composer...');
    await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2', timeout: 30000 });

    // Verify logged in
    if (page.url().includes('/i/flow/login')) {
      console.error('⚠️ X session expired or logged out.');
      await browser.close();
      return { ok: false, error: 'X session expired. Please re-login.' };
    }

    // Wait for text input
    const textSelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textSelector, { timeout: 15000 });
    await page.click(textSelector);
    
    // Type tweet copy cleanly
    await page.keyboard.sendCharacter('');
    await page.evaluate((selector, tweetText) => {
      const el = document.querySelector(selector);
      if (el) {
        el.focus();
        document.execCommand('insertText', false, tweetText);
      }
    }, textSelector, text);

    // Attach image if provided
    if (imagePath && fs.existsSync(imagePath)) {
      console.log('📸 Attaching editorial graphic to tweet...');
      const fileInput = await page.$('input[type="file"][data-testid="fileInput"]');
      if (fileInput) {
        await fileInput.uploadFile(imagePath);
        // Wait for image thumbnail to render
        await page.waitForTimeout ? page.waitForTimeout(3000) : new Promise(r => setTimeout(r, 3000));
      }
    }

    // Click Tweet Post button
    console.log('🚀 Clicking Tweet button...');
    const postButton = 'div[data-testid="tweetButton"]';
    await page.waitForSelector(postButton, { timeout: 10000 });
    await page.click(postButton);

    // Wait for tweet to dispatch
    await new Promise(r => setTimeout(r, 4000));
    console.log('✅ Successfully published to X (@YoXo_Station)!');

    await browser.close();
    return { ok: true };
  } catch (err) {
    console.error('❌ Failed to post to X:', err.message);
    try { await browser.close(); } catch(e) {}
    return { ok: false, error: err.message };
  }
}

module.exports = { postToX };
