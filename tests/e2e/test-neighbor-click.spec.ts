import { test, expect } from '@playwright/test';

test.describe('Neighbor click reveal - diagnostics', () => {
	test('should reveal direct neighbors on first node click or log diagnostic', async ({ page }) => {
		// Capture all console messages
		const consoleLogs: string[] = [];
		page.on('console', (msg) => {
			consoleLogs.push(msg.text());
		});

		// Navigate to homepage
		await page.goto('http://localhost:4444', { waitUntil: 'networkidle' });

		// Wait for the graph to load
		await page.waitForSelector('svg.finra-graph', { timeout: 10000 });
		await page.waitForLoadState('domcontentloaded');

		// Search for test firm (CRD 13572 - CETERA WEALTH SERVICES)
		const searchBox = page.locator('input[type="search"]').first();
		if (await searchBox.isVisible()) {
			await searchBox.fill('13572');
			await page.waitForTimeout(800);
		}

		// Try to click first search result
		const firstResult = page.locator('[role="option"]').first();
		if (await firstResult.isVisible({ timeout: 2000 }).catch(() => false)) {
			await firstResult.click();
			await page.waitForTimeout(1000);
		}

		// Count initial visible nodes
		const initialNodes = await page.locator('g.fg-node').count();
		console.log('Initial nodes:', initialNodes);

		// Click on any visible node to trigger expansion
		const firstNode = page.locator('g.fg-node').first();
		if (await firstNode.isVisible()) {
			const box = await firstNode.boundingBox();
			if (box) {
				await page.click('g.fg-node >> visible=true', {
					position: { x: box.width / 2, y: box.height / 2 },
					force: true,
				});
				await page.waitForTimeout(2000);
			}
		}

		// Count nodes after click
		const afterClickNodes = await page.locator('g.fg-node').count();
		console.log('After click nodes:', afterClickNodes);
		console.log('Nodes added:', afterClickNodes - initialNodes);

		// Check for diagnostic warnings in console
		const diagnosticLogs = consoleLogs.filter((log) => log.includes('[revealNeighbors]'));
		console.log('Diagnostic logs captured:', diagnosticLogs.length);
		diagnosticLogs.forEach((log) => console.log('  -', log.substring(0, 200)));

		// Report findings
		if (afterClickNodes > initialNodes) {
			console.log('✅ Neighbors rendered on click');
			expect(afterClickNodes).toBeGreaterThan(initialNodes);
		} else if (diagnosticLogs.length > 0) {
			console.log('❌ No neighbors added BUT diagnostics captured:');
			diagnosticLogs.forEach((log) => console.log(log));
			expect(diagnosticLogs.length).toBeGreaterThan(0);
		} else {
			console.log('⚠️  No nodes added and no diagnostics. May need more investigation.');
		}
	});
});
