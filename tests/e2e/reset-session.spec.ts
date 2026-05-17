import { expect, test } from '@playwright/test';

import { readStoredSession, readStoredSessionState, seedStoredSession } from './helpers/finra-e2e';

test('Reset Session overwrites persisted state with a cleared marker that survives reload', async ({ page }) => {
	await page.goto('/');
	const toggleMenuButton = page.getByRole('button', { name: 'Toggle menu' });
	const resetSessionButton = page.getByRole('button', { name: 'Reset Session' });

	await seedStoredSession(page, {
		selectedNodeId: 'person:3102054',
		sidebarViewMode: 'log',
		highlightedNodes: [{ id: 'person:3102054', hops: 1 }],
		extraNodeIds: ['person:3102054', 'firm:143571'],
	});

	await expect
		.poll(
			async () => {
				const session = await readStoredSession(page);
				return session?.data?.cleared === true;
			},
			{
				timeout: 10_000,
				message: 'expected Reset Session to replace persisted session data with a cleared marker',
			},
		)
		.toBe(false);

	await toggleMenuButton.click();
	await expect(resetSessionButton).toBeVisible();
	await resetSessionButton.click();

	await expect
		.poll(
			async () => {
				return readStoredSessionState(page);
			},
			{
				timeout: 10_000,
				message: 'expected Reset Session to persist a cleared marker and remove legacy session storage',
			},
		)
		.toEqual({ cleared: true, hasExpiry: true, legacyCleared: true });

	await page.reload();

	await expect(page.locator('#fg-main')).toBeVisible();
	await expect(page.locator('#fg-sidebar')).toHaveClass(/hidden/);
	await expect
		.poll(
			async () => {
				const session = await readStoredSession(page);
				return session?.data?.cleared === true;
			},
			{
				timeout: 10_000,
				message: 'expected the cleared session marker to survive reload',
			},
		)
		.toBe(true);
});
