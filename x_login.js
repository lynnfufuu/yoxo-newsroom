const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.resolve(__dirname, 'x_session.json');

async function loginToX() {
  console.log('🌐 Opening Chrome for 1-time X login...');
  console.log('👉 Please log into your @YoXo_Station account in the browser window.');
  console.log('⏳ Waiting for login confirmation...');

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox']
  });

  const page = await browser.newPage();
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2' });

  // Poll until user reaches home or auth_token cookie is present
  const checkInterval = setInterval(async () => {
    try {
      const cookies = await page.cookies();
      const authToken = cookies.find(c => c.name === 'auth_token');
      const ct0 = cookies.find(c => c.name === 'ct0');

      if (authToken && authToken.value) {
        clearInterval(checkInterval);
        console.log('🎉 Login detected successfully!');
        fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
        console.log(`💾 Saved session cookies to ${SESSION_FILE}`);
        console.log('✅ You can now close the browser window.');
        setTimeout(async () => {
          await browser.close();
          process.exit(0);
        }, 3000);
      }
    } catch (err) {
      // browser might be closing
    }
  }, 2000);
}

loginToX().catch(err => {
  console.error('Login error:', err.message);
  process.exit(1);
});
