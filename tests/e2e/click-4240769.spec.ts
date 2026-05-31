import { expect, test } from '@playwright/test';

import { resetBrowserGraphState } from './helpers/finra-e2e';

test('clicking person-4240769 expands neighbors and shows sidebar', async ({ page }) => {
	// Load the app root first so localStorage/session APIs are available
	await page.goto('/');
	// Ensure a clean graph/session state on the browser before navigating
	await resetBrowserGraphState(page);

	// Navigate directly to the node route which should request selection
	await page.goto('/node/person-4240769');

	// Wait for the sidebar to show the expected displayedId (node selection)
	await page.waitForFunction(
		() => {
			const side = document.getElementById('fg-sidebar');
			return !!side && side.dataset.displayedId === 'person:4240769';
		},
		{ timeout: 30000 },
	);

	// Allow a short grace period for DOM updates and neighbor reveal
	await page.waitForTimeout(500);

	const nodeCount = await page.locator('.fg-node').count();
	const linkCount = await page.locator('.fg-link').count();

	expect(nodeCount).toBeGreaterThan(1);
	expect(linkCount).toBeGreaterThan(0);
});
