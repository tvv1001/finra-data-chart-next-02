import { expect, test } from '@playwright/test';

test('Toggle menu opens the sidebar shell and Escape closes it again', async ({ page }) => {
	await page.goto('/');

	const app = page.locator('#finra-app');
	const sidebar = page.locator('#fg-sidebar');
	const backdrop = page.locator('#fg-sidebar-backdrop');
	const toggleMenuButton = page.getByRole('button', { name: 'Toggle menu' });

	await expect(sidebar).toHaveClass(/hidden/);
	await expect(backdrop).toHaveClass(/hidden/);
	await expect(app).toHaveAttribute('data-sidebar-open', 'false');

	await toggleMenuButton.click();

	await expect(sidebar).not.toHaveClass(/hidden/);
	await expect(backdrop).not.toHaveClass(/hidden/);
	await expect(app).toHaveAttribute('data-sidebar-open', 'true');
	await expect(page.getByRole('button', { name: 'Reset Session' })).toBeVisible();

	await page.keyboard.press('Escape');

	await expect(sidebar).toHaveClass(/hidden/);
	await expect(backdrop).toHaveClass(/hidden/);
	await expect(app).toHaveAttribute('data-sidebar-open', 'false');
});
