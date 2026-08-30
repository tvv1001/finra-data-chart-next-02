// playwright-extra-example.js
// Example: Using playwright-extra with stealth plugin

const { chromium } = require('playwright-extra');
const StealthPlugin = require('playwright-extra-plugin-stealth');

chromium.use(StealthPlugin());

(async () => {
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	await page.goto('https://example.com');
	console.log('Title:', await page.title());
	await browser.close();
})();
