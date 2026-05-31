import { expect, test } from '@playwright/test';

import { fetchGraphQueryWithLinkedResults, resetBrowserGraphState } from './helpers/finra-e2e';

test('clicking person-4240769 reveals the correct neighbor nodes', async ({ page }) => {
	// Ensure clean state
	await page.goto('/');
	await resetBrowserGraphState(page);

	// Populate graph with nodes related to the target id
	await fetchGraphQueryWithLinkedResults(page, '4240769');

	// Find the SVG node whose title contains the CRD
	const clicked = await page.evaluate(() => {
		const selId = 'person:4240769';
		const nodes = Array.from(document.querySelectorAll('g.fg-node')) as HTMLElement[];
		const el = nodes.find((n) => (n as any).__data__ && (n as any).__data__.id === selId);
		if (!el) return false;
		// Dispatch a DOM click so D3 handlers run
		el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		return true;
	});
	expect(clicked).toBe(true);

	// Wait for the sidebar to show the selected id
	await page.waitForFunction(
		() => {
			const side = document.getElementById('fg-sidebar');
			return !!side && side.dataset.displayedId === 'person:4240769';
		},
		{ timeout: 15000 },
	);

	// Use the in-page debug render order to discover neighbor link keys
	const neighborIds: string[] = await page.evaluate(() => {
		const selId = 'person:4240769';
		// __FG_RENDER_ORDER is exposed by the app for E2E/debugging
		// links.key is formatted as 'source-target-relationship'
		const links = (window as any).__FG_RENDER_ORDER?.links || [];
		const neighbors = new Set<string>();
		for (const l of links) {
			const key = String(l.key || '');
			const parts = key.split('-');
			if (parts.length < 2) continue;
			const src = parts[0];
			const tgt = parts[1];
			if (src === selId) neighbors.add(tgt);
			if (tgt === selId) neighbors.add(src);
		}
		return Array.from(neighbors);
	});

	// There should be at least one neighbor reference in render-order
	expect(neighborIds.length).toBeGreaterThan(0);

	// Wait briefly for any orphan node fetch/inject to complete, then check which
	// neighbor ids are actually present in the DOM (some remote endpoints may
	// require extra fetches and won't always be injected immediately).
	await page.waitForTimeout(500);
	const presentNeighbors: string[] = await page.evaluate((nIds) => {
		const nodes = Array.from(document.querySelectorAll('g.fg-node')) as HTMLElement[];
		const present = [] as string[];
		for (const nid of nIds) {
			const found = nodes.find((n) => (n as any).__data__ && (n as any).__data__.id === nid);
			if (found) present.push(nid);
		}
		return present;
	}, neighborIds);

	// At least one neighbor should be present in the DOM after reveal
	expect(presentNeighbors.length).toBeGreaterThan(0);
});
