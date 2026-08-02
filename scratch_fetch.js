const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  console.log('Navigating to http://localhost:3001/firm/79 ...');
  await page.goto('http://localhost:3001/firm/79', { waitUntil: 'networkidle' });
  
  console.log('Waiting for connections to load...');
  // Wait for some time or a specific element. We'll just wait a bit as instructed.
  await page.waitForTimeout(5000); 
  
  await page.screenshot({ path: '/home/lenny/Dev/webDev/finra-data-chart-next-02/scratch_screenshot.png', fullPage: true });
  console.log('Screenshot saved to scratch_screenshot.png');
  
  // Also get the HTML to see the classes/structure
  const html = await page.content();
  const fs = require('fs');
  fs.writeFileSync('/home/lenny/Dev/webDev/finra-data-chart-next-02/scratch_html.html', html);
  console.log('HTML saved to scratch_html.html');
  
  await browser.close();
})();
