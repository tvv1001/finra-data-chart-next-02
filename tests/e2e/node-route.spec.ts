import { expect, test } from '@playwright/test';

import { fetchGraphQueryWithLinkedResults, resetBrowserGraphState, seedStoredSession } from './helpers/finra-e2e';

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

test('Partial fetch queries still hit remote search even when a loosely matching node is already loaded', async ({ page }) => {
	const requestSequence: string[] = [];
	let localSearchRequestCount = 0;
	let remoteSearchRequestCount = 0;
	await page.route('**/api/finra/graph-search**', async (route) => {
		localSearchRequestCount += 1;
		requestSequence.push('local');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ nodes: [], links: [], matchedIds: [] }),
		});
	});
	await page.route('**/api/finra/search**', async (route) => {
		remoteSearchRequestCount += 1;
		requestSequence.push('external-finra');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});
	await page.route('**/api/finra/sec-search**', async (route) => {
		remoteSearchRequestCount += 1;
		requestSequence.push('external-sec');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:3102054',
				label: 'Regression Person One',
				group: 'individual',
				crd: '3102054',
			},
			{
				id: 'firm:143571',
				label: 'Regression Firm Two',
				group: 'firm',
				firmId: '143571',
			},
		],
		extraLinks: [
			{
				source: 'person:3102054',
				target: 'firm:143571',
				relationship: 'employed_by',
				isCurrent: true,
			},
		],
	});
	await page.reload();

	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded session graph to render before testing fetch behavior',
		})
		.toBeGreaterThan(0);

	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-fetch-remote');
	await fetchInput.fill('Regression');
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 10_000 });

	await expect
		.poll(() => localSearchRequestCount, {
			timeout: 10_000,
			message: 'expected the local graph-search API to be consulted before any page-node shortcut',
		})
		.toBeGreaterThan(0);

	await expect
		.poll(() => remoteSearchRequestCount, {
			timeout: 10_000,
			message: 'expected a local miss to continue on to remote search before any page-node fallback',
		})
		.toBeGreaterThan(0);

	expect(requestSequence[0]).toBe('local');
	await expect(page.locator('#fg-subset-info')).not.toContainText('Already loaded', { timeout: 5_000 });
});

test('Local API hits short-circuit external search before page-node reuse', async ({ page }) => {
	const requestSequence: string[] = [];
	let localSearchRequestCount = 0;
	let remoteSearchRequestCount = 0;
	await page.route('**/api/finra/graph-search**', async (route) => {
		localSearchRequestCount += 1;
		requestSequence.push('local');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [
					{
						id: 'person:3102054',
						label: 'Regression Person One',
						group: 'individual',
						crd: '3102054',
					},
					{
						id: 'firm:143571',
						label: 'Regression Firm Two',
						group: 'firm',
						firmId: '143571',
					},
				],
				links: [
					{
						source: 'person:3102054',
						target: 'firm:143571',
						relationship: 'employed_by',
						isCurrent: true,
					},
				],
				matchedIds: ['person:3102054'],
			}),
		});
	});
	await page.route('**/api/finra/search**', async (route) => {
		remoteSearchRequestCount += 1;
		requestSequence.push('external-finra');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});
	await page.route('**/api/finra/sec-search**', async (route) => {
		remoteSearchRequestCount += 1;
		requestSequence.push('external-sec');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:3102054',
				label: 'Regression Person One',
				group: 'individual',
				crd: '3102054',
			},
		],
	});
	await page.reload();
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded session graph to render before testing the local-hit shortcut',
		})
		.toBeGreaterThan(0);

	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-fetch-remote');
	await fetchInput.fill('3102054');
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 10_000 });

	await expect
		.poll(() => localSearchRequestCount, {
			timeout: 10_000,
			message: 'expected an exact query to hit the local graph-search API first',
		})
		.toBeGreaterThan(0);

	await expect
		.poll(() => remoteSearchRequestCount, {
			timeout: 10_000,
			message: 'expected a local API hit to short-circuit the external search endpoints',
		})
		.toBe(0);

	expect(requestSequence).toEqual(['local']);
	await expect(page.locator('#fg-subset-info')).toContainText('Loaded from local API', { timeout: 5_000 });
});
