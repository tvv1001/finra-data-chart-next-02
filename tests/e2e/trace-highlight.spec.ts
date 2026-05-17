import { expect, Page, test } from '@playwright/test';

import { fetchGraphQueryWithLinkedResults, resetBrowserGraphState } from './helpers/finra-e2e';

type TraceTargets = {
	sourceIndex: number;
	targetIndex: number;
};

async function getTraceTargets(page: Page): Promise<TraceTargets> {
	const traceTargets = await page.evaluate(() => {
		const nodes = Array.from(document.querySelectorAll<Element>('.fg-node'));
		const sourceIndex = nodes.findIndex((element) => /3102054|Seon Lyndon Harry/i.test(element.textContent || ''));
		const targetIndex = nodes.findIndex((element, index) => index !== sourceIndex && !/CRD:/i.test(element.textContent || '') && Boolean(element.textContent?.trim()));

		if (sourceIndex < 0 || targetIndex < 0) {
			return null;
		}

		return { sourceIndex, targetIndex };
	});

	if (!traceTargets) {
		throw new Error('Unable to derive trace targets from rendered graph data.');
	}

	return traceTargets;
}

test('Trace with Log applies trace classes to rendered graph nodes', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	await fetchGraphQueryWithLinkedResults(page, '3102054');

	const { sourceIndex, targetIndex } = await getTraceTargets(page);
	const sourceNode = page.locator('.fg-node').nth(sourceIndex);
	const targetNode = page.locator('.fg-node').nth(targetIndex);

	await sourceNode.click({ force: true });
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await targetNode.click({ force: true });
	const sidebarLogToggle = page.getByRole('button', { name: 'Show selection log' });
	await expect(sidebarLogToggle).toBeVisible();
	await sidebarLogToggle.click();
	await expect(page.locator('#fg-sidebar-selection-log-list .fg-log-entry')).toHaveCount(2);

	const sidebarTraceButton = page.locator('#fg-sidebar [data-fg-selection-log-action="trace"]').first();
	await expect(sidebarTraceButton).toBeVisible();
	await sidebarTraceButton.click();

	await expect(sidebarTraceButton).toHaveText('Log Trace On');
	await expect(sidebarTraceButton).toHaveAttribute('aria-pressed', 'true');
	await expect(sourceNode).toHaveClass(/trace-log/);
	await expect(targetNode).toHaveClass(/trace-log/);
	await expect
		.poll(async () => page.locator('.fg-node.trace-log, .fg-node.trace-log-connector').count(), {
			timeout: 10_000,
			message: 'expected Trace with Log to highlight rendered graph nodes',
		})
		.toBeGreaterThan(1);
});
