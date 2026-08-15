const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 1080 });
  await page.goto('http://localhost:4444/dashboard/firm/13051');
  await page.waitForTimeout(3000); // Wait for load
  
  const html = await page.evaluate(() => {
      const el = document.querySelector('.dashboard-module__XABe8G__readableCardPanel');
      return el ? el.innerHTML : 'No panel found';
  });
  console.log("Panel HTML:", html);
  
  await browser.close();
})();
