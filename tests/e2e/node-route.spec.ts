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

test('A direct node route keeps a fetched inactive leaf node both selected and visibly inactive', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.route('**/api/finra/expand/person%3A999999**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [
					{
						id: 'person:999999',
						label: 'Inactive Route Person',
						group: 'individual',
						crd: '999999',
						hasFinraData: true,
						bcScope: 'InActive',
						registrationCount: {
							approvedFinraRegistrationCount: 0,
							approvedSRORegistrationCount: 0,
							approvedStateRegistrationCount: 0,
							approvedIAStateRegistrationCount: 0,
						},
						currentEmployments: [],
						currentIAEmployments: [],
						previousEmployments: [{ firmId: '1' }],
						previousIAEmployments: [],
						registeredStates: [],
						registeredSROs: [],
					},
				],
				links: [],
			}),
		});
	});

	await page.route('**/api/finra/individual/999999**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				basicInformation: {
					individualId: '999999',
					firstName: 'Inactive',
					lastName: 'Route Person',
					bcScope: 'InActive',
				},
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				currentEmployments: [],
				currentIAEmployments: [],
				previousEmployments: [{ firmId: '1' }],
				previousIAEmployments: [],
				registeredStates: [],
				registeredSROs: [],
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/node/person-999999');

	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/, { timeout: 20_000 });
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the direct inactive node route to restore the selected node in the sidebar',
			},
		)
		.toBe('person:999999');

	const inactiveSelectedNode = page.locator('.fg-node').filter({ hasText: 'Inactive Route Person' });
	await expect(inactiveSelectedNode).toHaveCount(1);
	await expect(inactiveSelectedNode).toHaveClass(/selected/);
	await expect(inactiveSelectedNode).toHaveClass(/fg-node--inactive/);
	await expect(page.locator('.fg-link')).toHaveCount(0);
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

test('Fetched search results show inactive people as disabled before selection', async ({ page }) => {
	await page.route('**/api/finra/graph-reset**', async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
	});
	await page.route('**/api/finra/graph?**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: { subset: true, profile: 'custom', renderedNodes: 0, totalNodes: 0, totalLinks: 0 },
			}),
		});
	});
	await page.route('**/api/finra/search?**', async (route) => {
		const url = new URL(route.request().url());
		const firm = url.searchParams.get('firm');
		if (firm === '1') {
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits: { hits: [] } }) });
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				hits: {
					hits: [
						{
							_source: {
								ind_source_id: '1302190',
								ind_firstname: 'ALAN',
								ind_lastname: 'MASON',
								ind_bc_scope: 'InActive',
								ind_ia_scope: 'InActive',
								ind_approved_finra_registration_count: 0,
								ind_current_employments: [],
							},
						},
						{
							_source: {
								ind_source_id: '8085958',
								ind_firstname: 'JOHN',
								ind_middlename: 'MCLEAN',
								ind_lastname: 'MASON',
								ind_bc_scope: 'Active',
								ind_ia_scope: 'NotInScope',
								ind_approved_finra_registration_count: 1,
								ind_current_employments: [{ firm_id: '143571', firm_name: 'Regression Firm' }],
							},
						},
					],
				},
			}),
		});
	});
	await page.route('**/api/finra/sec-search?**', async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits: { hits: [] } }) });
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-fetch-remote');
	await fetchInput.fill('mason');
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 10_000 });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected fetched Mason results to render graph nodes',
		})
		.toBeGreaterThan(0);

	const nodeStates = await page.locator('.fg-node').evaluateAll((els) =>
		els.map((el) => ({
			text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
			classes: el.getAttribute('class') || '',
		})),
	);
	const inactiveNode = nodeStates.find((node) => /Alan Mason/i.test(node.text));
	const activeNode = nodeStates.find((node) => /John Mclean Mason/i.test(node.text));
	expect(inactiveNode?.classes).toContain('fg-node--inactive');
	expect(inactiveNode?.classes).not.toContain('selected');
	expect(activeNode?.classes).toContain('fg-node--individual');
	expect(activeNode?.classes).not.toContain('fg-node--inactive');
	expect(activeNode?.classes).not.toContain('selected');
});
