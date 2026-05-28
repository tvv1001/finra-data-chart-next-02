import { expect, test } from '@playwright/test';

import { deterministicSelectionLogEntries, readStoredSelectionLog, seedStandaloneSelectionLog } from './helpers/finra-e2e';

test('Clear empties the standalone selection log and persists the empty state', async ({ page }) => {
	await page.goto('/');
	await seedStandaloneSelectionLog(page, deterministicSelectionLogEntries);

	await page.reload();

	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(2);

	await page.evaluate(() => {
		const traceButton = document.getElementById('btn-selection-log-trace') as HTMLButtonElement | null;
		traceButton?.click();
	});

	await expect(page.locator('#btn-selection-log-trace')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('#fg-selection-log')).toBeVisible();

	await page.locator('#btn-selection-log-clear').click();

	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(0);
	await expect(page.locator('#fg-selection-log')).toBeVisible();
	await expect(page.locator('#btn-selection-log-trace')).toHaveAttribute('aria-pressed', 'true');
	await expect
		.poll(
			async () => {
				const storedLog = await readStoredSelectionLog(page);
				return Array.isArray(storedLog) ? storedLog.length : -1;
			},
			{
				timeout: 10_000,
				message: 'expected Clear to persist an empty selection log',
			},
		)
		.toBe(0);

	await page.reload();

	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(0);
});
