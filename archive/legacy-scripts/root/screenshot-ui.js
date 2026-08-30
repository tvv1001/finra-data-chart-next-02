const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1080 });
  await page.goto('http://localhost:4444/dashboard/individual/1028056');
  await page.waitForTimeout(5000); // Wait for load
  await page.screenshot({ path: 'local_screenshot.png', fullPage: true });
  await browser.close();
  console.log("Screenshot saved to local_screenshot.png");
})();
