const { chromium } = require('playwright');
async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:4444/individual/4317416', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'screenshot.png' });
  const html = await page.content();
  console.log(html.slice(0, 1000));
  await browser.close();
}
run();
