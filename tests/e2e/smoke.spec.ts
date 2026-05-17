import { expect, test } from '@playwright/test';

test('loads the core graph shell', async ({ page }) => {
	await page.goto('/');

	await expect(page.locator('#finra-app')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'FINRA' })).toBeVisible();
	await expect(page.locator('#fg-fetch-input')).toBeVisible();
	await expect(page.locator('#fg-fetch-remote')).toBeVisible();
	await expect(page.locator('#fg-svg')).toBeVisible();
	await expect(page.locator('#fg-main')).toBeVisible();
});
