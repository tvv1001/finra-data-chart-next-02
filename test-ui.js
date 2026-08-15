const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:4444/dashboard/firm/160481');
  await page.waitForTimeout(5000); // Wait for load

  const text = await page.textContent('body');
  if (text.includes('Regulatory Event')) {
      console.log('Summary card IS visible!');
  } else {
      console.log('Summary card is NOT visible.');
  }

  const disclosuresHTML = await page.evaluate(() => {
      const el = document.querySelector('h4:contains("Disclosures")')?.parentElement;
      return el ? el.innerHTML : 'No disclosure section found';
  });
  console.log("Disclosure HTML:", disclosuresHTML);

  await browser.close();
})();
