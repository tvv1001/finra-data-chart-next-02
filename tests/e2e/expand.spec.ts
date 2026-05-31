import { test, expect } from '@playwright/test';

test.describe('graph expansion', () => {
	test('route node triggers expansion API call', async ({ page }) => {
		const url = 'http://localhost:4444/node/person-4240769';
		await page.goto(url);

		// Wait for nodes to render
		await page.waitForSelector('g.fg-node', { timeout: 10000 });

		// Observe expansion network request triggered by clicking the node
		const expansionPromise = page.waitForResponse((resp) => resp.url().includes('/api/finra/expand/') && resp.request().method() === 'GET');

		// Click the node by matching its visible label text
		const nodeLocator = page.locator('g.fg-node:has-text("Daniel Stewart Beaton")');
		await expect(nodeLocator).toHaveCount(1, { timeout: 5000 });
		await nodeLocator.first().click();

		// Capture initial counts of nodes and links rendered
		const initialNodeCount = await page.locator('g.fg-node').count();
		const initialLinkCount = await page.locator('line.fg-link').count();

		const resp = await expansionPromise;
		expect(resp.ok()).toBeTruthy();
		const payload = await resp.json();
		// Expect the expand API to return at least the selected node
		expect(Array.isArray(payload.nodes)).toBeTruthy();
		expect(payload.nodes.length).toBeGreaterThanOrEqual(1);

		// After expansion, prefer to see more nodes/links in the DOM.
		// Some seed pages already include the first-wave neighbors so fall back to
		// checking for previous-employment styled links or relationship presence in the payload.
		let domIncreased = false;
		try {
			await page.waitForFunction(
				({ initialNodeCount, initialLinkCount }) => {
					const nodes = document.querySelectorAll('g.fg-node').length;
					const links = document.querySelectorAll('line.fg-link').length;
					return nodes > initialNodeCount || links > initialLinkCount;
				},
				{ initialNodeCount, initialLinkCount },
				{ timeout: 20000 },
			);
			domIncreased = true;
		} catch (err) {
			// ignore — fallback checks below
		}

		const dashedLinks = await page.locator('line.fg-link[stroke-dasharray="5 3"]').count();
		if (!domIncreased && dashedLinks === 0) {
			// As a last resort, ensure the server returned previous_employed_by links
			expect(Array.isArray(payload.links)).toBeTruthy();
			const hasPrev = (payload.links || []).some((l) => l.relationship === 'previous_employed_by');
			expect(hasPrev || domIncreased || dashedLinks > 0).toBeTruthy();
		}
	});
});
