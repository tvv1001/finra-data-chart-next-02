import { expect, test } from '@playwright/test';

import { readStoredSession, readStoredSessionState, resetBrowserGraphState, seedStoredSession } from './helpers/finra-e2e';

test('New empty custom sessions autofocus the fetch input', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	await expect(page.locator('#fg-empty')).not.toHaveClass(/hidden/);
	await expect
		.poll(async () => page.evaluate(() => document.activeElement?.id || ''), {
			timeout: 10_000,
			message: 'expected the fetch input to receive focus for a new empty session',
		})
		.toBe('fg-fetch-input');
});

test('Reset Session overwrites persisted state with a cleared marker that survives reload', async ({ page }) => {
	await page.goto('/');
	const sidebar = page.locator('#fg-sidebar');
	const toggleMenuButton = page.getByRole('button', { name: 'Toggle menu' });
	const resetSessionButton = page.locator('#fg-sidebar [data-fg-action="clear-session"]');

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

	await expect(sidebar).toHaveClass(/hidden/);
	await toggleMenuButton.click();
	await expect(sidebar).not.toHaveClass(/hidden/);
	await expect(resetSessionButton).toBeVisible();
	await resetSessionButton.evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.locator('#fg-empty')).not.toHaveClass(/hidden/);
	await expect
		.poll(async () => page.evaluate(() => document.activeElement?.id || ''), {
			timeout: 10_000,
			message: 'expected Reset Session to move focus back to the fetch input',
		})
		.toBe('fg-fetch-input');

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
	await expect
		.poll(async () => page.evaluate(() => document.activeElement?.id || ''), {
			timeout: 10_000,
			message: 'expected the fetch input to regain focus after reloading a cleared session',
		})
		.toBe('fg-fetch-input');
});
