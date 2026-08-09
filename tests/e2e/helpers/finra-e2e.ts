import { expect, Page } from '@playwright/test';

export type SelectionLogEntry = {
	id: string;
	label: string;
	secondaryId: string;
	group: string;
};

export type SessionEnvelope = {
	expiresAt: number;
	data: Record<string, unknown> | null;
};

export const deterministicSelectionLogEntries: SelectionLogEntry[] = [
	{
		id: 'person:3102054',
		label: 'Regression Person One',
		secondaryId: 'CRD# 3102054',
		group: 'individual',
	},
	{
		id: 'firm:143571',
		label: 'Regression Firm Two',
		secondaryId: 'CRD# 143571',
		group: 'firm',
	},
];

export async function seedStandaloneSelectionLog(page: Page, entries: SelectionLogEntry[] = deterministicSelectionLogEntries) {
	await page.evaluate((selectionLogEntries: SelectionLogEntry[]) => {
		localStorage.removeItem('finra_session');
		sessionStorage.removeItem('finra_session');
		localStorage.removeItem('finra_sidebar_pinned');
		localStorage.removeItem('finra_selection_log_pinned');
		localStorage.setItem('finra_selection_log', JSON.stringify(selectionLogEntries));
	}, entries);
}

export async function readStoredSelectionLog(page: Page) {
	return page.evaluate(() => {
		const raw = localStorage.getItem('finra_selection_log');
		return raw ? (JSON.parse(raw) as SelectionLogEntry[]) : null;
	});
}

export async function resetBrowserGraphState(page: Page) {
	await page.evaluate(async () => {
		localStorage.removeItem('finra_session');
		sessionStorage.removeItem('finra_session');
		localStorage.removeItem('finra_selection_log');
		localStorage.removeItem('finra_sidebar_pinned');
		localStorage.removeItem('finra_selection_log_pinned');
		// Intentionally leave finra_graph_templates intact: templates are durable bookmarks.
		await fetch('/api/finra/graph-reset', {
			method: 'POST',
			cache: 'no-store',
		});
	});
}

export async function fetchGraphQueryWithLinkedResults(page: Page, query: string, options: { timeout?: number } = {}) {
	const { timeout = 45_000 } = options;
	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-database-search');

	await fetchInput.fill(query);
	await expect(fetchButton).toBeEnabled();
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 45_000 });

	await expect
		.poll(
			async () => {
				return page.evaluate(() => {
					const statusText = document.getElementById('fg-bottom-status')?.textContent || '';
					return /Displayed:\s+\d+\s+People\s+\d+\s+Firms\s+[1-9]\d*\s+Links/i.test(statusText);
				});
			},
			{
				timeout,
				message: `expected query ${query} to render a graph with links`,
			},
		)
		.toBe(true);
}

export async function seedStoredSession(page: Page, data: Record<string, unknown>, expiresInMs = 60_000) {
	await page.evaluate(
		({ sessionData, sessionTtlMs }) => {
			const envelope = {
				expiresAt: Date.now() + sessionTtlMs,
				data: sessionData,
			};
			localStorage.setItem('finra_session', JSON.stringify(envelope));
			sessionStorage.setItem('finra_session', JSON.stringify({ legacy: true }));
		},
		{ sessionData: data, sessionTtlMs: expiresInMs },
	);
}

export async function readStoredSession(page: Page) {
	return page.evaluate(() => {
		const raw = localStorage.getItem('finra_session');
		if (!raw) return null;
		return JSON.parse(raw) as SessionEnvelope;
	});
}

export async function readStoredSessionState(page: Page) {
	return page.evaluate(() => {
		const raw = localStorage.getItem('finra_session');
		const session = raw ? (JSON.parse(raw) as SessionEnvelope) : null;
		return {
			cleared: session?.data?.cleared === true,
			hasExpiry: typeof session?.expiresAt === 'number' && Number.isFinite(session.expiresAt),
			legacyCleared: sessionStorage.getItem('finra_session') === null,
		};
	});
}
