const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  
  await page.goto('http://localhost:4444/', { waitUntil: 'domcontentloaded' });
  
  console.log("Waiting for graph to render...");
  await page.waitForFunction('window.layoutNodes !== undefined', { timeout: 15000 }).catch(() => console.log('layoutNodes not found'));
  
  await page.evaluate(async () => {
    console.log("Checking if finraGraphClick exists: " + (typeof window.finraGraphClick));
    if (typeof window.finraGraphClick === 'function') {
      console.log("Clicking person:4873777");
      window.finraGraphClick({ id: 'person:4873777', group: 'individual', crd: '4873777' });
    }
  });
  
  await new Promise(resolve => setTimeout(resolve, 8000));
  await browser.close();
})();
