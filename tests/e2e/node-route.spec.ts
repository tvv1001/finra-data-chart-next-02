import { expect, test } from '@playwright/test';

import { fetchGraphQueryWithLinkedResults, resetBrowserGraphState } from './helpers/finra-e2e';

async function getRenderedNodeIndex(page: Parameters<typeof test>[0]['page'], matcher: RegExp) {
	const index = await page.evaluate((patternSource) => {
		const pattern = new RegExp(patternSource, 'i');
		const nodes = Array.from(document.querySelectorAll<Element>('.fg-node'));
		return nodes.findIndex((element) => pattern.test(element.textContent || ''));
	}, matcher.source);
	if (index < 0) {
		throw new Error(`Unable to find rendered node matching ${matcher}.`);
	}
	return index;
}

test('Selecting a node pushes an analytics-friendly node route', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	await fetchGraphQueryWithLinkedResults(page, '3102054');

	const sourceIndex = await getRenderedNodeIndex(page, /3102054|Seon Lyndon Harry/);
	const sourceNode = page.locator('.fg-node').nth(sourceIndex);
	await sourceNode.click({ force: true });

	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 10_000,
			message: 'expected selecting a node to push a /node/... route',
		})
		.toBe('/node/person-3102054');
});

test('A direct node route restores that node selection on a clean session', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/node/person-3102054');

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 10_000,
			message: 'expected the direct node route to remain active after load',
		})
		.toBe('/node/person-3102054');

	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/, { timeout: 20_000 });
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the direct node route to restore the selected node in the sidebar',
			},
		)
		.toBe('person:3102054');
});

test('A legacy encoded node route still restores that node selection', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/node/person%3A3102054');

	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/, { timeout: 20_000 });
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the legacy encoded node route to restore the selected node in the sidebar',
			},
		)
		.toBe('person:3102054');
});
