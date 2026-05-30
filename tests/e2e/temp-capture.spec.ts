import { test } from '@playwright/test';

test('capture logs for person 4240769', async ({ page }) => {
	const logs: string[] = [];

	page.on('console', (msg) => {
		try {
			logs.push(`console ${msg.type()}: ${msg.text()}`);
		} catch (e) {
			logs.push(`console [error reading message]: ${String(e)}`);
		}
	});

	page.on('response', async (response) => {
		try {
			const url = response.url();
			if (url.includes('/api/finra/individual/') || url.includes('/api/finra/merged/individual/')) {
				let text = '';
				try {
					text = await response.text();
				} catch (e) {
					text = `<body read error: ${e}>`;
				}
				const preview = text.length > 2000 ? text.slice(0, 2000) + '...[truncated]' : text;
				logs.push(`response ${response.status()} ${url} ${preview}`);
			}
		} catch (e) {
			logs.push(`response [error reading response]: ${String(e)}`);
		}
	});

	await page.goto('http://localhost:4444/node/person-4240769', { waitUntil: 'networkidle' });
	// Give the client extra time to perform any lazy fetches or UI updates
	await page.waitForTimeout(4000);

	// Print collected logs so the test runner captures them
	for (const line of logs) console.log(line);

	// Fail the test if no relevant API responses were observed
	if (!logs.some((l) => l.includes('/api/finra/merged/individual/') || l.includes('/api/finra/individual/'))) {
		throw new Error('No individual/merged API responses were captured in the session');
	}
});
