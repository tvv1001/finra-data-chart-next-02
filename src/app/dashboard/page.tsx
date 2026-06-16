'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeRenderablePayload, renderJsonForDisplay } from '../../lib/dashboard-json';
import styles from './dashboard.module.css';

type DashboardAction = 'fetch-crds' | 'list-new-crds';

type ApiResponse = {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
};

type SearchResult = Record<string, any>;

type SearchResultSource = 'finra' | 'sec';

type SearchResultCard = {
	id: string;
	label: string;
	scope: string;
	source: SearchResultSource;
	entity: 'individual' | 'firm';
	payload: SearchResult;
};

type QueueCardSourceEntry = {
	source: SearchResultSource;
	status: 'ok' | 'skipped' | 'error' | 'unknown';
	error?: string;
	skipReason?: string;
};

type QueueCard = {
	id: string;
	entity: 'individual' | 'firm';
	files: number;
	sources: QueueCardSourceEntry[];
	since?: string;
	kind?: 'recent';
	name?: string | null;
	statusText?: string | null;
	memberSince?: string | null;
	savedRecordCount?: number;
	updatedExistingRecordCount?: number;
	updatedExistingSourceCount?: number;
	skippedSourceCount?: number;
	trueErrorCount?: number;
};

type QueueRunItem = {
	query: string;
	status: 'queued' | 'running' | 'complete' | 'nomatch' | 'error';
	elapsedSec: number;
	message?: string;
	newRec?: number;
	updatedRec?: number;
	errRec?: number;
};

type UrlSelectionInput = {
	entity: 'individual' | 'firm';
	id: string;
	source: SearchResultSource;
	availableSources?: SearchResultSource[];
};

export function parseDashboardSelectionFromUrl(urlString: string): UrlSelectionInput | null {
	try {
		const url = new URL(urlString, 'http://localhost');
		const params = url.searchParams;
		const firmId = String(params.get('CRD_firm') || '').trim();
		const individualId = String(params.get('CRD_individual') || '').trim();
		const id = firmId || individualId;
		if (!/^\d{1,10}$/.test(id)) return null;

		const sourceParam = String(params.get('source') || '')
			.trim()
			.toLowerCase();
		const source: SearchResultSource = sourceParam === 'sec' ? 'sec' : 'finra';
		const availableSources: SearchResultSource[] = [];
		if (params.get('finra') === '1') availableSources.push('finra');
		if (params.get('sec') === '1') availableSources.push('sec');
		if (!availableSources.includes(source)) availableSources.push(source);

		return {
			entity: firmId ? 'firm' : 'individual',
			id,
			source,
			availableSources,
		};
	} catch {
		return null;
	}
}

function parseQueueQueries(input: string) {
	return input
		.split(/[\n,;]+/g)
		.map((value) => value.trim())
		.filter(Boolean);
}

export function computeQueryFetchCounts(resolution: Array<{ query?: string; crds?: string[] }>, fetchedItems: Array<{ crd?: string; status?: string }>) {
	const counts = new Map<string, number>();

	for (const entry of resolution) {
		const query = String(entry?.query || '').trim();
		if (!query) continue;

		const crdSet = new Set((Array.isArray(entry?.crds) ? entry.crds : []).map((value) => String(value || '').trim()).filter(Boolean));

		const addedCount = fetchedItems.filter((item) => crdSet.has(String(item?.crd || '').trim()) && String(item?.status || '') === 'ok').length;
		counts.set(query, addedCount);
	}

	return Object.fromEntries(counts.entries());
}

export function computeQuerySaveStats(
	resolution: Array<{ query?: string; crds?: string[] }>,
	fetchedItems: Array<{ crd?: string; type?: string; status?: string; cardKey?: string; newSourceSaved?: boolean; newRecordSaved?: boolean }>,
) {
	const stats = new Map<
		string,
		{
			fetchedCount: number;
			skippedCount: number;
			savedSourceCount: number;
			savedRecordCount: number;
			updatedExistingSourceCount: number;
			updatedExistingRecordCount: number;
			errorCount: number;
		}
	>();

	for (const entry of resolution) {
		const query = String(entry?.query || '').trim();
		if (!query) continue;

		const crdSet = new Set((Array.isArray(entry?.crds) ? entry.crds : []).map((value) => String(value || '').trim()).filter(Boolean));
		const matchingItems = fetchedItems.filter((item) => crdSet.has(String(item?.crd || '').trim()));
		const savedRecordKeys = new Set(
			matchingItems
				.filter((item) => item?.newRecordSaved === true)
				.map((item) => String(item?.cardKey || `${String(item?.type || 'individual')}:${String(item?.crd || '').trim()}`)),
		);
		const updatedExistingRecordKeys = new Set(
			matchingItems
				.filter((item) => item?.newSourceSaved === true && item?.newRecordSaved !== true)
				.map((item) => String(item?.cardKey || `${String(item?.type || 'individual')}:${String(item?.crd || '').trim()}`)),
		);

		stats.set(query, {
			fetchedCount: matchingItems.filter((item) => String(item?.status || '') === 'ok').length,
			skippedCount: matchingItems.filter((item) => String(item?.status || '') === 'skipped').length,
			savedSourceCount: matchingItems.filter((item) => item?.newSourceSaved === true).length,
			savedRecordCount: savedRecordKeys.size,
			updatedExistingSourceCount: matchingItems.filter((item) => item?.newSourceSaved === true && item?.newRecordSaved !== true).length,
			updatedExistingRecordCount: updatedExistingRecordKeys.size,
			errorCount: matchingItems.filter((item) => String(item?.status || '') === 'error').length,
		});
	}

	return Object.fromEntries(stats.entries());
}

export function describeQuerySaveChange(stats?: { savedRecordCount?: number; updatedExistingRecordCount?: number; updatedExistingSourceCount?: number }) {
	const newRecordCount = Number(stats?.savedRecordCount || 0);
	const updatedExistingRecordCount = Number(stats?.updatedExistingRecordCount || 0);
	const updatedExistingSourceCount = Number(stats?.updatedExistingSourceCount || 0);

	if (newRecordCount > 0 && updatedExistingRecordCount > 0) {
		return `${newRecordCount} new CRD${newRecordCount === 1 ? '' : 's'} • ${updatedExistingRecordCount} existing CRD${updatedExistingRecordCount === 1 ? '' : 's'} gained ${updatedExistingSourceCount} new source${updatedExistingSourceCount === 1 ? '' : 's'}`;
	}

	if (newRecordCount > 0) {
		return `${newRecordCount} new CRD${newRecordCount === 1 ? '' : 's'}`;
	}

	if (updatedExistingRecordCount > 0) {
		return `${updatedExistingRecordCount} existing CRD${updatedExistingRecordCount === 1 ? '' : 's'} gained ${updatedExistingSourceCount} new source${updatedExistingSourceCount === 1 ? '' : 's'}`;
	}

	return 'no new data saved';
}

export function shouldShowQueueCardError(card: { sources?: Array<{ source?: string; status?: string; error?: string; skipReason?: string }> }) {
	return Array.isArray(card.sources) && card.sources.some((entry) => String(entry?.status || '') === 'error');
}

export function shouldShowQueueCardSkipped(card: { sources?: Array<{ source?: string; status?: string; error?: string; skipReason?: string }> }) {
	return Array.isArray(card.sources) && !shouldShowQueueCardError(card) && card.sources.some((entry) => String(entry?.status || '') === 'skipped');
}

export function describeDashboardRequestFailure(options: { status?: number; contentType?: string | null; bodyText?: string; errorMessage?: string; elapsedSec?: number }) {
	const status = Number(options.status || 0);
	const contentType = String(options.contentType || '').toLowerCase();
	const bodyText = String(options.bodyText || '');
	const errorMessage = String(options.errorMessage || '');
	const elapsedSec = Math.max(0, Number(options.elapsedSec || 0));
	const combined = `${bodyText}\n${errorMessage}`.toLowerCase();
	if (combined.includes('aborted without reason') || combined.includes('request aborted') || combined.includes('aborterror')) {
		return 'Queue request was cancelled by the browser timeout. The crawl may still be running; please wait a bit longer and try again.';
	}
	const timeoutLike =
		status === 408 ||
		status === 504 ||
		status === 524 ||
		combined.includes('timed out') ||
		combined.includes('timeout') ||
		combined.includes('function invocation') ||
		combined.includes('gateway') ||
		combined.includes('body exceeded');

	if (timeoutLike) {
		return `Queue likely timed out after ${elapsedSec || 30}s. Try fewer names or rerun in smaller chunks.`;
	}

	if (status >= 500 && !contentType.includes('application/json')) {
		return 'Queue failed before the dashboard received JSON. The server likely returned an HTML or gateway error page.';
	}

	if (status >= 400 && bodyText.trim()) {
		return bodyText.trim().slice(0, 240);
	}

	return errorMessage || 'Queue request failed.';
}

export function buildQueueCardsFromFetchResults(items: any[]): QueueCard[] {
	const map = new Map<string, QueueCard>();
	for (const item of items) {
		const id = String(item?.crd || '').trim();
		const source = String(item?.source || '')
			.trim()
			.toLowerCase() as SearchResultSource;
		const entity =
			(
				String(item?.type || '')
					.trim()
					.toLowerCase() === 'firm'
			) ?
				'firm'
			:	'individual';
		if (!/^\d{1,10}$/.test(id)) continue;
		if (source !== 'finra' && source !== 'sec') continue;

		const key = `${entity}:${id}`;
		const existing = map.get(key) || {
			id,
			entity,
			files: 0,
			sources: [],
		};

		existing.files += 1;
		const nextSource: QueueCardSourceEntry = {
			source,
			status:
				item?.status === 'error' ? 'error'
				: item?.status === 'skipped' ? 'skipped'
				: item?.status === 'ok' ? 'ok'
				: 'unknown',
			error: item?.error ? String(item.error) : undefined,
			skipReason: item?.skipReason ? String(item.skipReason) : undefined,
		};

		const sourceIndex = existing.sources.findIndex((entry) => entry.source === source);
		if (sourceIndex >= 0) existing.sources[sourceIndex] = nextSource;
		else existing.sources.push(nextSource);

		map.set(key, existing);
	}

	return Array.from(map.values());
}

function normalizePayloadForCleanView(payload: unknown) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

	const obj = payload as Record<string, any>;
	if (Array.isArray(obj?.hits?.hits) && obj.hits.hits.length) {
		const source = obj.hits.hits[0]?._source ?? obj.hits.hits[0];
		if (source && typeof source === 'object') {
			return normalizeRenderablePayload(source);
		}
	}

	return normalizeRenderablePayload(obj);
}

function extractEntityDetailFromPayload(payload: any, entity: 'individual' | 'firm', crd: string) {
	if (!payload || typeof payload !== 'object') return null;

	// Handle nested Elasticsearch response structure (hits.hits[0]._source)
	let data = payload;
	if (Array.isArray(payload?.hits?.hits) && payload.hits.hits.length > 0) {
		data = payload.hits.hits[0]?._source || {};
	}

	// Normalize payload structure - handle raw API responses with content/iacontent wrappers
	let normalized = data;
	if (typeof data.content === 'string') {
		try {
			normalized = JSON.parse(data.content);
		} catch {
			// If parse fails, continue with the original data
		}
	}
	if (typeof data.iacontent === 'string') {
		try {
			normalized = { ...normalized, ...JSON.parse(data.iacontent) };
		} catch {
			// If parse fails, continue with the current normalized data
		}
	}

	// For individuals
	if (entity === 'individual') {
		const firstName = normalized.bc?.firstName || normalized.ia?.firstName || normalized.basicInformation?.firstName || '';
		const lastName = normalized.bc?.lastName || normalized.ia?.lastName || normalized.basicInformation?.lastName || '';
		const name = [firstName, lastName].filter(Boolean).join(' ').trim();
		const bcScope = normalized.bc?.bcScope || normalized.basicInformation?.bcScope || 'N/A';
		const iaScope = normalized.ia?.iaScope || normalized.basicInformation?.iaScope || 'N/A';

		return {
			id: crd,
			entity,
			name: name || `Individual ${crd}`,
			status: [bcScope, iaScope].filter((s) => s && s !== 'N/A').join(' • ') || 'No status',
		};
	}

	// For firms
	if (entity === 'firm') {
		const legalName = normalized.legalName || normalized.basicInformation?.legalName || '';
		const doingBusinessAs = normalized.doingBusinessAs || normalized.basicInformation?.doingBusinessAs || '';
		const name = legalName || doingBusinessAs || `Firm ${crd}`;

		return {
			id: crd,
			entity,
			name,
			status: 'Firm',
		};
	}

	return null;
}

export default function DashboardPage() {
	const [crdInput, setCrdInput] = useState('');
	const [externalRawDir, setExternalRawDir] = useState('/home/lenny/Dev/webDev/Data-finra-sec/data/raw');
	const [busyAction, setBusyAction] = useState<DashboardAction | null>(null);
	const [result, setResult] = useState<ApiResponse | null>(null);
	const [mainJson, setMainJson] = useState<Record<string, any> | null>(null);
	const [mainJsonLabel, setMainJsonLabel] = useState('');
	const [currentRecordSource, setCurrentRecordSource] = useState<'finra' | 'sec' | null>(null);
	const [currentRecordEntity, setCurrentRecordEntity] = useState<'individual' | 'firm' | null>(null);
	const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
	const [newCrds, setNewCrds] = useState<Array<{ id: string; type: string; found: string; scopes: string[]; date: string }>>([]);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [searchResults, setSearchResults] = useState<SearchResultCard[]>([]);
	const [searchSkippedCount, setSearchSkippedCount] = useState(0);
	const [crawlProgress, setCrawlProgress] = useState<{ active: boolean; current: number; total: number; query: string; ok: number; new: number; updated: number; err: number } | null>(null);
	const [queueStatusLine, setQueueStatusLine] = useState('Idle | - | queue - | elapsed 0s');
	const [queueQueryLines, setQueueQueryLines] = useState<string[]>([]);
	const [queueElapsedSec, setQueueElapsedSec] = useState(0);
	const [queueRunItems, setQueueRunItems] = useState<QueueRunItem[]>([]);
	const [queueCards, setQueueCards] = useState<QueueCard[]>([]);
	const [queueCrdFilter, setQueueCrdFilter] = useState('');
	const [queueMetaStats, setQueueMetaStats] = useState<{
		shownCount: number;
		totalCount: number;
		totalCacheKeys: number;
		filteredTotalCount?: number;
		sourceMode?: string;
		persistenceNotice?: string | null;
		inventoryTotals?: { people: number; firms: number; unique: number; source?: string };
	}>({
		shownCount: 0,
		totalCount: 0,
		totalCacheKeys: 0,
	});
	const [syncBannerText, setSyncBannerText] = useState<string | null>(null);
	const [activeCardSourceKey, setActiveCardSourceKey] = useState<string | null>(null);
	const [rightPaneCollapsed, setRightPaneCollapsed] = useState(false);
	const [rightPaneNotice, setRightPaneNotice] = useState<string | null>(null);
	const [jsonRenderBusy, setJsonRenderBusy] = useState(false);
	const [codeBlock, setCodeBlock] = useState('');
	const [recordUpdatedAt, setRecordUpdatedAt] = useState<string | null>(null);
	const [top10Latest, setTop10Latest] = useState<Array<{ id: string; entity: 'individual' | 'firm'; fetchedAt: string; files?: number; sources?: QueueCardSourceEntry[] }>>([]);
	const mergedDetailCacheRef = useRef(new Map<string, any>());
	const jsonStringCacheRef = useRef(new Map<string, string>());
	const previousNewCrdsCountRef = useRef(0);

	const queueQueries = useMemo(() => parseQueueQueries(crdInput), [crdInput]);
	const parsedCrds = useMemo(() => queueQueries.filter((value) => /^\d{1,10}$/.test(value)), [queueQueries]);

	useEffect(() => {
		if (busyAction !== 'fetch-crds') return;

		const timer = window.setInterval(() => {
			setQueueElapsedSec((current) => current + 1);
			setQueueRunItems((items) =>
				items.map((item) =>
					item.status === 'running' ?
						{
							...item,
							elapsedSec: item.elapsedSec + 1,
						}
					:	item,
				),
			);
		}, 1000);

		return () => {
			window.clearInterval(timer);
		};
	}, [busyAction]);

	useEffect(() => {
		if (busyAction !== 'fetch-crds') return;
		setQueueStatusLine((prev) => {
			if (/elapsed\s+\d+s/i.test(prev)) {
				return prev.replace(/elapsed\s+\d+s/i, `elapsed ${queueElapsedSec}s`);
			}
			return `Searching | Queue | queue 1/${Math.max(1, queueQueries.length)} | elapsed ${queueElapsedSec}s`;
		});
	}, [busyAction, queueElapsedSec, queueQueries.length]);

	// Load recent CRDs on mount
	useEffect(() => {
		fetch('/api/dashboard/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'list-new-crds' }),
		})
			.then((res) => res.json())
			.then((data) => {
				if (data.ok) {
					setNewCrds(data.newCrds || []);
				}
			})
			.catch((err) => console.error('Failed to load new CRDs:', err));
	}, []);

	const hasCurrentRecord = Boolean(mainJson || result);

	useEffect(() => {
		const payload = mainJson || result;
		if (!payload) {
			setCodeBlock('');
			setJsonRenderBusy(false);
			return;
		}

		const cacheKey = mainJson ? `main:${mainJsonLabel}` : `result:${String((result as any)?.ok)}:${String((result as any)?.error || '')}`;
		const cached = jsonStringCacheRef.current.get(cacheKey);
		if (cached != null) {
			setCodeBlock(cached);
			setJsonRenderBusy(false);
			return;
		}

		setJsonRenderBusy(true);
		let cancelled = false;

		const compute = () => {
			if (cancelled) return;
			try {
				const text = renderJsonForDisplay(payload);
				jsonStringCacheRef.current.set(cacheKey, text);
				if (!cancelled) setCodeBlock(text);
			} catch (error: any) {
				if (!cancelled) setCodeBlock(String(error?.message || error || 'Failed to render JSON'));
			} finally {
				if (!cancelled) setJsonRenderBusy(false);
			}
		};

		if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
			const idleId = (window as any).requestIdleCallback(compute, { timeout: 180 });
			return () => {
				cancelled = true;
				if (typeof (window as any).cancelIdleCallback === 'function') {
					(window as any).cancelIdleCallback(idleId);
				}
			};
		}

		const timeoutId = window.setTimeout(compute, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(timeoutId);
		};
	}, [mainJson, result, mainJsonLabel]);

	useEffect(() => {
		if (newCrds.length > previousNewCrdsCountRef.current) {
			const delta = newCrds.length - previousNewCrdsCountRef.current;
			setRightPaneNotice(`${delta} new CRD${delta === 1 ? '' : 's'} available in the right panel.`);
		} else if (previousNewCrdsCountRef.current === 0 && newCrds.length > 0) {
			setRightPaneNotice('New CRDs are ready in the right panel.');
		} else if (newCrds.length === 0) {
			setRightPaneNotice(null);
		}
		previousNewCrdsCountRef.current = newCrds.length;
	}, [newCrds.length]);

	useEffect(() => {
		if (queueCards.length > 0) {
			const now = new Date().toISOString();
			const realCards = queueCards.filter((card) => (card.sources?.length ?? 0) > 0 || card.files > 0);
			const newItems = realCards.slice(0, 10).map((card) => ({
				id: card.id,
				entity: card.entity,
				fetchedAt: now,
				files: card.files,
				sources: card.sources,
			}));
			setTop10Latest((prev) => {
				const combined = [...newItems, ...prev];
				const deduped = Array.from(new Map(combined.map((item) => [`${item.entity}:${item.id}`, item])).values());
				return deduped.slice(0, 10);
			});
		}
	}, [queueCards]);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		if (currentRecordId) return;

		const selection = parseDashboardSelectionFromUrl(window.location.href);
		if (!selection) return;

		const card: QueueCard = {
			id: selection.id,
			entity: selection.entity,
			files: Math.max(1, selection.availableSources?.length || 1),
			sources: (selection.availableSources || [selection.source]).map((source) => ({
				source,
				status: 'unknown',
			})),
		};

		void loadQueueSourceJson(card, selection.source);
	}, [currentRecordId]);

	const searchSummary = useMemo(() => {
		if (!searchQuery.trim()) return 'Search saved records by name';
		if (searchBusy) return 'Searching Redis...';
		if (searchError) return searchError;
		if (!searchResults.length) return 'No Redis results yet';
		if (searchSkippedCount > 0) {
			return `${searchResults.length} Redis result${searchResults.length === 1 ? '' : 's'} found • ${searchSkippedCount} skipped (missing CRD or corrupt)`;
		}
		return `${searchResults.length} Redis result${searchResults.length === 1 ? '' : 's'} found`;
	}, [searchBusy, searchError, searchQuery, searchResults.length, searchSkippedCount]);

	const queueMetaText = useMemo(() => {
		const shown = Number(queueMetaStats.shownCount || queueCards.length || 0);
		const total = Number(queueMetaStats.totalCount || shown);
		const filteredTotal = Number(queueMetaStats.filteredTotalCount || shown);
		const filterSuffix = queueCrdFilter.trim().length > 0 ? ` Filtered: ${filteredTotal.toLocaleString()} matched.${filteredTotal === 0 ? ' (No cached match yet)' : ''}` : '';
		return `Showing recent results from ${shown.toLocaleString()} loaded records (${total.toLocaleString()} total cached records).${filterSuffix}`;
	}, [queueCards.length, queueMetaStats, queueCrdFilter]);

	const persistenceNotice = useMemo(() => {
		if (queueMetaStats.persistenceNotice) return queueMetaStats.persistenceNotice;
		if (queueMetaStats.sourceMode === 'local-fallback') {
			return 'Durable Redis persistence is unavailable here, so recent fetches may be temporary and not reload as saved cache cards.';
		}
		return null;
	}, [queueMetaStats.persistenceNotice, queueMetaStats.sourceMode]);

	const uniqueCrdCounts = useMemo(() => {
		if (queueMetaStats.inventoryTotals) {
			return {
				individuals: queueMetaStats.inventoryTotals.people,
				firms: queueMetaStats.inventoryTotals.firms,
				total: queueMetaStats.inventoryTotals.unique,
			};
		}

		const individuals = new Set<string>();
		const firms = new Set<string>();
		queueCards.forEach((card) => {
			if (card.entity === 'individual') {
				individuals.add(card.id);
			} else if (card.entity === 'firm') {
				firms.add(card.id);
			}
		});
		return {
			individuals: individuals.size,
			firms: firms.size,
			total: individuals.size + firms.size,
		};
	}, [queueCards, queueMetaStats.inventoryTotals]);

	const hasInventorySummary = useMemo(() => {
		return queueMetaStats.totalCount > 0 || queueMetaStats.totalCacheKeys > 0 || queueCards.length > 0 || uniqueCrdCounts.individuals > 0 || uniqueCrdCounts.firms > 0;
	}, [queueCards.length, queueMetaStats.totalCacheKeys, queueMetaStats.totalCount, uniqueCrdCounts.firms, uniqueCrdCounts.individuals]);

	const mergedQueueCards = useMemo(() => {
		const merged = new Map<string, QueueCard>();

		// 1. Absolute recency priority: Top 10 latest from session memory
		if (!queueCrdFilter.trim()) {
			for (const item of top10Latest.filter((entry) => (entry.sources?.length ?? 0) > 0)) {
				const key = `${item.entity}:${item.id}`;
				merged.set(key, {
					id: item.id,
					entity: item.entity,
					files: item.files ?? 1,
					sources: item.sources ?? [],
					since: item.fetchedAt ? `Recently fetched ${new Date(item.fetchedAt).toLocaleString()}` : 'Recently fetched',
					kind: 'recent',
				});
			}
		}

		// 2. Queue cards (current session results or Redis inventory)
		for (const card of queueCards) {
			const key = `${card.entity}:${card.id}`;
			if (merged.has(key)) {
				const existing = merged.get(key)!;
				// Merge properties, keeping the 'recent' status/label from top10Latest if it was there
				merged.set(key, { ...card, ...existing });
			} else {
				merged.set(key, card);
			}
		}

		return Array.from(merged.values());
	}, [queueCards, top10Latest, queueCrdFilter]);

	const filteredNewCrds = useMemo(() => {
		const token = queueCrdFilter.trim();
		if (!token) return [] as Array<(typeof newCrds)[number]>;
		const tokens = token
			.split(/[\s,;]+/g)
			.map((value) => value.trim())
			.filter(Boolean);
		return newCrds.filter((item) => tokens.some((value) => item.id === value || item.id.includes(value)));
	}, [newCrds, queueCrdFilter]);

	function markRecordUpdatedAt(value?: unknown) {
		const raw = typeof value === 'string' ? value.trim() : '';
		if (raw) {
			setRecordUpdatedAt(raw);
			return;
		}
		setRecordUpdatedAt(new Date().toISOString());
	}

	function extractValidCrd(item: SearchResult, entity: 'individual' | 'firm') {
		const candidateKeys =
			entity === 'individual' ?
				['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id']
			:	['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];

		for (const key of candidateKeys) {
			const raw = item?.[key];
			if (raw == null) continue;
			const value = String(raw).trim();
			if (/^\d{1,10}$/.test(value)) return value;
		}

		return '';
	}

	function isCorruptSearchItem(item: unknown) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
		const obj = item as SearchResult;
		const hasSignalField = [
			obj.individualId,
			obj.firmId,
			obj.crd,
			obj.ind_crd,
			obj.firm_crd,
			obj.ind_source_id,
			obj.firm_source_id,
			obj.name,
			obj.fullName,
			obj.firmName,
			obj.status,
		].some((value) => value != null && String(value).trim().length > 0);
		return !hasSignalField;
	}

	function setMainViewFromSearch(card: SearchResultCard, sourceLabel: string) {
		setMainJson(normalizePayloadForCleanView(card.payload) as Record<string, any>);
		setCurrentRecordSource(card.source);
		setCurrentRecordEntity(card.entity);
		setCurrentRecordId(card.id);
		setMainJsonLabel(`${String(card.source).toUpperCase()} ${card.entity.toUpperCase()} • ${sourceLabel}`);
		markRecordUpdatedAt();
		syncSelectionToUrl({
			entity: card.entity,
			id: card.id,
			source: card.source,
			availableSources: [card.source],
		});
	}

	function syncSelectionToUrl({ entity, id, source, availableSources = [source] }: UrlSelectionInput) {
		if (typeof window === 'undefined') return;
		if (!/^\d{1,10}$/.test(String(id || '').trim())) return;

		const url = new URL(window.location.href);
		const params = url.searchParams;
		const recordId = String(id).trim();
		const hasFinra = availableSources.includes('finra');
		const hasSec = availableSources.includes('sec');

		if (entity === 'firm') {
			params.set('CRD_firm', recordId);
			params.delete('CRD_individual');
		} else {
			params.set('CRD_individual', recordId);
			params.delete('CRD_firm');
		}

		params.set('source', source);
		if (hasFinra) params.set('finra', '1');
		else params.delete('finra');
		if (hasSec) params.set('sec', '1');
		else params.delete('sec');

		window.history.replaceState({}, '', `${url.pathname}?${params.toString()}${url.hash}`);
	}

	function isSelectedCardSource(card: QueueCard, source: SearchResultSource) {
		return currentRecordId === card.id && currentRecordEntity === card.entity && currentRecordSource === source;
	}

	function extractPayloadFromDetail(detail: any, source: SearchResultSource) {
		if (!detail || typeof detail !== 'object') return null;
		if (source === 'finra') {
			return detail?.sources?.finra?.bccontent ?? detail?.sources?.finra ?? detail?.finraNode ?? detail?.merged ?? detail?.bccontent ?? null;
		}
		return detail?.sources?.sec?.iacontent ?? detail?.sources?.sec ?? detail?.finraNode ?? detail?.merged ?? detail?.iacontent ?? null;
	}

	async function loadQueueCardsFromRedis(filter = '') {
		try {
			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					action: 'list-cache-cards',
					maxCards: filter.trim() ? 200 : 20,
					crdFilter: filter,
				}),
			});

			const payload = await response.json().catch(() => null);
			if (payload?.ok === false) {
				setQueueCards([]);
				setQueueMetaStats({ shownCount: 0, totalCount: 0, totalCacheKeys: 0, filteredTotalCount: 0, persistenceNotice: null });
				return;
			}

			const cards = Array.isArray(payload?.cards) ? payload.cards : [];
			setQueueCards((current) => {
				const sourceMode = String(payload?.sourceMode || '');
				if (cards.length === 0 && sourceMode === 'local-fallback' && current.length > 0) {
					return current;
				}
				return cards as QueueCard[];
			});
			setQueueMetaStats({
				shownCount: Number(payload?.shownCount || cards.length || 0),
				totalCount: Number(payload?.totalCount || cards.length || 0),
				totalCacheKeys: Number(payload?.totalCacheKeys || 0),
				...(payload?.filteredTotalCount != null ? { filteredTotalCount: Number(payload.filteredTotalCount || 0) } : {}),
				...(payload?.sourceMode ? { sourceMode: String(payload.sourceMode) } : {}),
				...(payload?.persistenceNotice !== undefined ? { persistenceNotice: payload.persistenceNotice ? String(payload.persistenceNotice) : null } : {}),
				...(payload?.inventoryTotals ? { inventoryTotals: payload.inventoryTotals } : {}),
			});
		} catch {
			// keep existing cards on load errors
		}
	}

	useEffect(() => {
		void loadQueueCardsFromRedis(queueCrdFilter);

		const intervalId = setInterval(() => {
			void loadQueueCardsFromRedis(queueCrdFilter);
		}, 15000);

		return () => clearInterval(intervalId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [queueCrdFilter]);

	async function fetchMergedDetail(card: QueueCard) {
		const cacheKey = `${card.entity}:${card.id}`;
		const cached = mergedDetailCacheRef.current.get(cacheKey);
		if (cached) return cached;

		const route = card.entity === 'firm' ? `/api/finra/merged/firm/${card.id}` : `/api/finra/merged/individual/${card.id}`;
		const response = await fetch(route, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			cache: 'no-store',
		});
		const detail = await response.json();
		mergedDetailCacheRef.current.set(cacheKey, detail);
		return detail;
	}

	async function fetchFallbackDetail(card: QueueCard) {
		const route = card.entity === 'firm' ? `/api/finra/firm/${card.id}?merged=1` : `/api/finra/individual/${card.id}?merged=1&includePrevious=true`;

		const response = await fetch(route, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			cache: 'no-store',
		});

		return response.json();
	}

	async function refreshSingleCardRecord(card: QueueCard, source: SearchResultSource) {
		const response = await fetch('/api/dashboard/refresh', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'fetch-crds',
				queries: [card.id],
				crds: [card.id],
				maxCrds: 1,
				includePayload: true,
			}),
		});

		const payload = await response.json().catch(() => null);
		const items = Array.isArray(payload?.results) ? payload.results : [];
		const match = items.find(
			(item: any) =>
				String(item?.crd || '') === card.id &&
				String(item?.source || '').toLowerCase() === source &&
				String(item?.type || '').toLowerCase() === card.entity &&
				item?.status === 'ok' &&
				item?.payload,
		);

		return match?.payload ?? null;
	}

	async function loadQueueSourceJson(card: QueueCard, source: SearchResultSource) {
		const sourceKey = `${card.entity}:${card.id}:${source}`;
		setActiveCardSourceKey(sourceKey);
		try {
			const detail = await fetchMergedDetail(card);
			let payload = extractPayloadFromDetail(detail, source);

			if (!payload) {
				const fallbackDetail = await fetchFallbackDetail(card);
				payload = extractPayloadFromDetail(fallbackDetail, source);
				if (payload) {
					mergedDetailCacheRef.current.set(`${card.entity}:${card.id}`, fallbackDetail);
				}
			}

			if (!payload) {
				const directRefreshedPayload = await refreshSingleCardRecord(card, source);
				if (directRefreshedPayload) {
					payload = directRefreshedPayload;
				}

				mergedDetailCacheRef.current.delete(`${card.entity}:${card.id}`);
				if (!payload) {
					const refreshedDetail = await fetchMergedDetail(card);
					payload = extractPayloadFromDetail(refreshedDetail, source);
				}

				if (!payload) {
					const refreshedFallbackDetail = await fetchFallbackDetail(card);
					payload = extractPayloadFromDetail(refreshedFallbackDetail, source);
					if (payload) {
						mergedDetailCacheRef.current.set(`${card.entity}:${card.id}`, refreshedFallbackDetail);
					}
				}

				void loadQueueCardsFromRedis(queueCrdFilter);
			}

			if (!payload) {
				setMainJsonLabel(`${source}:${card.entity}:${card.id}`);
				setCurrentRecordSource(source);
				setCurrentRecordEntity(card.entity);
				setCurrentRecordId(card.id);
				setResult({
					ok: false,
					error: `No ${String(source).toUpperCase()} payload found for ${card.entity} ${card.id} after merged/fallback lookup and auto-refresh retry.`,
				});
				return;
			}

			setMainJson(normalizePayloadForCleanView(payload) as Record<string, any>);
			setCurrentRecordSource(source);
			setCurrentRecordEntity(card.entity);
			setCurrentRecordId(card.id);
			setMainJsonLabel(`${source}:${card.entity}:${card.id}`);
			markRecordUpdatedAt();
			syncSelectionToUrl({
				entity: card.entity,
				id: card.id,
				source,
				availableSources: card.sources.map((entry) => entry.source),
			});
		} catch (error: any) {
			setResult({ ok: false, error: error?.message || String(error) });
		} finally {
			setActiveCardSourceKey((current) => (current === sourceKey ? null : current));
		}
	}

	async function runAction(action: DashboardAction, overrideQueries?: string[]) {
		setBusyAction(action);
		setResult(null);
		setRecordUpdatedAt(null);
		const startedAt = Date.now();
		const effectiveQueries =
			action === 'fetch-crds' ?
				overrideQueries && overrideQueries.length > 0 ?
					overrideQueries
				:	queueQueries
			:	[];

		if (action === 'fetch-crds') {
			setQueueElapsedSec(0);
			setQueueRunItems(effectiveQueries.map(q => ({ query: q, status: 'queued', elapsedSec: 0 })));
			setCrawlProgress({ active: true, current: 0, total: effectiveQueries.length, query: '', ok: 0, new: 0, updated: 0, err: 0 });

			let totalSuccess = 0;
			let totalError = 0;
			let totalNew = 0;
			let totalUpdated = 0;

			for (let i = 0; i < effectiveQueries.length; i++) {
				const query = effectiveQueries[i];
				setQueueRunItems(prev => prev.map((item, idx) => idx === i ? { ...item, status: 'running' } : item));
				setCrawlProgress(p => p ? { ...p, current: i + 1, query } : null);
				
				try {
					const response = await fetch('/api/dashboard/refresh', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ action: 'fetch-crds', queries: [query], maxCrds: 1, includePayload: true }),
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

					const summary = payload.summary || {};
					const results = payload.results || [];
					let qNew = 0, qUpd = 0, qErr = 0;
					let qNewPeople = 0, qNewFirms = 0;
					
					for (const r of results) {
						if (r.status === 'error') {
							qErr++;
						} else if (r.newRecordSaved) {
							qNew++;
							if (String(r.type).toLowerCase() === 'firm') qNewFirms++;
							else qNewPeople++;
						} else if (r.newSourceSaved) {
							qUpd++;
						}
					}

					totalNew += qNew;
					totalUpdated += qUpd;
					totalSuccess += summary.successCount || 0;
					totalError += qErr;

					setCrawlProgress(p => p ? { ...p, ok: totalSuccess, new: totalNew, updated: totalUpdated, err: totalError } : null);

					if (qNew > 0) {
						// Optimistic UI counter update
						setQueueMetaStats(current => {
							const t = current.inventoryTotals;
							if (!t) return current;
							return { 
								...current, 
								inventoryTotals: { 
									...t, 
									unique: Number(t.unique || 0) + qNew,
									people: Number(t.people || 0) + qNewPeople,
									firms: Number(t.firms || 0) + qNewFirms
								} 
							};
						});
						
						// Fire backend sync
						void fetch('/api/dashboard/refresh', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ action: 'increment-inventory-counter', amount: qNew }),
						}).then(() => loadQueueCardsFromRedis(queueCrdFilter));
					} else if (qUpd > 0) {
						void loadQueueCardsFromRedis(queueCrdFilter);
					}

					setQueueRunItems(prev => prev.map((item, idx) => {
						if (idx !== i) return item;
						const resolved = (payload.resolution || []).find((r: any) => String(r.query).trim() === String(query).trim());
						return {
							...item,
							status: (resolved?.crdCount || 0) > 0 ? 'complete' : 'nomatch',
							message: '',
							newRec: qNew,
							updatedRec: qUpd,
							errRec: qErr
						};
					}));

				} catch (err: any) {
					totalError++;
					setCrawlProgress(p => p ? { ...p, err: totalError } : null);
					setQueueRunItems(prev => prev.map((item, idx) => idx === i ? { ...item, status: 'error', message: err.message } : item));
				}
			}

			setCrawlProgress(p => p ? { ...p, active: false } : null);
			setBusyAction(null);
			window.setTimeout(() => setQueueRunItems([]), 10000);
			return;
		}

		try {
			const body =
				action === 'list-new-crds' ?
					{
						action,
					}
				:	{
						action,
						externalRawDir,
					};

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort('dashboard-request-timeout'), 15 * 60 * 1000);

			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			const contentType = response.headers.get('content-type');
			const rawText = await response.text();
			let payload: ApiResponse | null = null;
			if (contentType?.includes('application/json')) {
				payload = JSON.parse(rawText) as ApiResponse;
			}

			if (!response.ok || !payload) {
				throw new Error(
					describeDashboardRequestFailure({
						status: response.status,
						contentType,
						bodyText: rawText,
						elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
					}),
				);
			}

			if (payload.ok === false) {
				throw new Error(
					describeDashboardRequestFailure({
						status: response.status,
						contentType,
						bodyText: String(payload.error || rawText || ''),
						elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
					}),
				);
			}
			setResult(payload);
			markRecordUpdatedAt((payload as any)?.at);

			if (action === 'list-new-crds') {
				const newCrdsData = (payload as any)?.newCrds || [];
				setNewCrds(newCrdsData);
			}
		} catch (error: any) {
			setResult({ ok: false, error: error?.message || String(error) });
			markRecordUpdatedAt();
		} finally {
			setBusyAction(null);
		}
	}

	async function runRedisSearch() {
		const query = searchQuery.trim();
		if (!query) {
			setSearchResults([]);
			setSearchError(null);
			setSearchSkippedCount(0);
			return;
		}

		setSearchBusy(true);
		setSearchError(null);
		setSearchResults([]);
		setSearchSkippedCount(0);

		try {
			const [finraIndividualRes, finraFirmRes, secIndividualRes, secFirmRes] = await Promise.all([
				fetch(`/api/finra/search?type=individual&query=${encodeURIComponent(query)}&rows=8`),
				fetch(`/api/finra/search?type=firm&query=${encodeURIComponent(query)}&rows=8`),
				fetch(`/api/finra/sec-search?query=${encodeURIComponent(query)}&rows=8`),
				fetch(`/api/finra/sec-search-firm?query=${encodeURIComponent(query)}&rows=8`),
			]);

			const [finraIndividualJson, finraFirmJson, secIndividualJson, secFirmJson] = await Promise.all([
				finraIndividualRes.json(),
				finraFirmRes.json(),
				secIndividualRes.json(),
				secFirmRes.json(),
			]);

			const getItems = (payload: any) =>
				Array.isArray(payload?.results) ? payload.results
				: Array.isArray(payload?.currentPage) ? payload.currentPage
				: Array.isArray(payload?.hits?.hits) ? payload.hits.hits.map((hit: any) => hit?._source ?? hit)
				: [];

			const normalize = (items: SearchResult[], source: SearchResultSource, entity: 'individual' | 'firm') => {
				let skipped = 0;
				const cards: SearchResultCard[] = [];

				for (const item of items) {
					if (isCorruptSearchItem(item)) {
						skipped += 1;
						continue;
					}

					const id = extractValidCrd(item, entity);
					if (!id) {
						skipped += 1;
						continue;
					}

					const label = String(item?.name || item?.fullName || item?.firmName || item?.firstName || item?.lastName || item?.title || 'Result').trim();
					const scope = String(item?.bcScope || item?.iaScope || item?.status || item?.registrationStatus || '').trim();
					cards.push({ id, label, scope, source, entity, payload: item });
				}

				return { cards, skipped };
			};

			const finraIndividuals = normalize(getItems(finraIndividualJson), 'finra', 'individual');
			const finraFirms = normalize(getItems(finraFirmJson), 'finra', 'firm');
			const secIndividuals = normalize(getItems(secIndividualJson), 'sec', 'individual');
			const secFirms = normalize(getItems(secFirmJson), 'sec', 'firm');

			const skippedTotal = finraIndividuals.skipped + finraFirms.skipped + secIndividuals.skipped + secFirms.skipped;
			if (skippedTotal > 0) {
				console.warn('[dashboard] skipped search records due to missing CRD or corrupt payload', {
					query,
					skippedTotal,
				});
			}

			setSearchSkippedCount(skippedTotal);
			setSearchResults([...finraIndividuals.cards, ...finraFirms.cards, ...secIndividuals.cards, ...secFirms.cards]);
		} catch (error: any) {
			setSearchError(error?.message || String(error));
		} finally {
			setSearchBusy(false);
		}
	}

	function renderSearchResult(card: SearchResultCard, index: number) {
		const sourceLabel = card.source === 'finra' ? 'FINRA' : 'SEC';

		return (
			<div
				key={`${card.entity}:${card.id}:${card.source}:${index}`}
				className={styles.searchResultCard}>
				<div className={styles.searchResultTop}>
					<strong>{card.id}</strong>
					<button
						type='button'
						className={styles.searchSourceBtn}
						onClick={() => setMainViewFromSearch(card, sourceLabel)}>
						{sourceLabel}
					</button>
				</div>
				<div className={styles.searchResultLabel}>{card.label}</div>
				{card.scope && <div className={styles.searchResultScope}>{card.scope}</div>}
				<div className={styles.searchResultPayloadHint}>Click {sourceLabel} to open JSON in the main view</div>
			</div>
		);
	}

	const visibleRunItems = useMemo(() => {
		if (queueRunItems.length === 0) return [];
		const runningIndex = queueRunItems.findIndex((item) => item.status === 'running');
		
		let windowIndices: number[] = [];
		if (runningIndex === -1) {
			const lastFinished = [...queueRunItems].reverse().findIndex(item => item.status === 'complete' || item.status === 'nomatch' || item.status === 'error');
			const baseIndex = lastFinished === -1 ? 0 : (queueRunItems.length - 1 - lastFinished);
			windowIndices = [baseIndex - 1, baseIndex, baseIndex + 1];
		} else {
			windowIndices = [runningIndex - 1, runningIndex, runningIndex + 1];
		}

		return windowIndices.map(idx => {
			if (idx >= 0 && idx < queueRunItems.length) return queueRunItems[idx];
			return null;
		});
	}, [queueRunItems]);

	return (
		<div className={styles.page}>
			<div className={`${styles.layout} ${rightPaneCollapsed ? styles.layoutCollapsedRight : ''}`}>
				<aside className={styles.leftPane}>
					<Link
						href='/'
						className={styles.backLink}>
						← Graph
					</Link>

					<textarea
						className={styles.queueInput}
						value={crdInput}
						onChange={(event) => setCrdInput(event.target.value)}
						spellCheck={false}
						autoCorrect='off'
						autoCapitalize='none'
						placeholder='Enter CRD(s) or name query(ies), comma separated'
					/>
					<button
						type='button'
						className={styles.primaryBtn}
						onClick={() => runAction('fetch-crds')}
						disabled={busyAction !== null || queueQueries.length === 0}>
						{busyAction === 'fetch-crds' ? 'Running…' : 'Run Queue'}
					</button>

					<div className={styles.queueStatusPanel}>
						<div className={styles.statusLine}>{queueStatusLine}</div>
						<div className={styles.queueStatusList}>
							{queueQueryLines.map((line, index) => (
								<div
									key={`${line}-${index}`}
									className={styles.queueStatusRow}>
									{line}
								</div>
							))}
						</div>
					</div>

					{hasInventorySummary && (
						<div className={styles.uniqueCrdCount}>
							<div className={styles.countItem}>
								<div className={styles.countLabel}>People</div>
								<div className={styles.countValue}>{uniqueCrdCounts.individuals.toLocaleString()}</div>
							</div>
							<div className={styles.countItem}>
								<div className={styles.countLabel}>Firms</div>
								<div className={styles.countValue}>{uniqueCrdCounts.firms.toLocaleString()}</div>
							</div>
							<div className={styles.countItem}>
								<div className={styles.countLabel}>Total CRDs</div>
								<div className={styles.countValue}>{uniqueCrdCounts.total.toLocaleString()}</div>
							</div>
						</div>
					)}

					{visibleRunItems.length > 0 && (
						<div className={styles.queueRunList}>
							{visibleRunItems.map((item, index) => (
								item ? (
									<div
										key={`${item.query}-${index}`}
										className={styles.queueRunItem}>
										<div className={styles.queueRunTop}>
											<span className={styles.queueRunQuery}>{item.query}</span>
											<span className={[styles.queueRunBadge, styles['queueRunBadge_' + item.status]].filter(Boolean).join(' ')}>{item.status}</span>
										</div>
										{item.status === 'complete' && (
											<div className={styles.queueRunMeta}>
												{[
													item.newRec ? `${item.newRec} new` : null,
													item.updatedRec ? `${item.updatedRec} updated` : null,
													item.errRec ? `${item.errRec} errors` : null,
													(!item.newRec && !item.updatedRec && !item.errRec) ? 'No changes' : null
												].filter(Boolean).join(' • ')}
											</div>
										)}
										{item.status === 'nomatch' && <div className={styles.queueRunMeta}>No match</div>}
										{item.status === 'error' && <div className={styles.queueRunMeta}>{item.message}</div>}
									</div>
								) : (
									<div key={`empty-${index}`} className={styles.queueRunItem} style={{ opacity: 0.3, borderStyle: 'dashed' }}>
										<div className={styles.queueRunTop}>
											<span className={styles.queueRunQuery}>-</span>
											<span className={styles.queueRunBadge}>Empty</span>
										</div>
										<div className={styles.queueRunMeta}>
											{index === 0 ? 'Previous' : index === 2 ? 'Next' : '-'}
										</div>
									</div>
								)
							))}
						</div>
					)}

					<div className={styles.queueSectionTitle}>Run Queue</div>
					<div className={styles.queueMeta}>{queueMetaText}</div>
					{persistenceNotice && <div className={styles.searchSummary}>{persistenceNotice}</div>}
					<div className={styles.cardList}>
						{mergedQueueCards.map((card, index) => (
							<div
								key={`${card.entity}:${card.id}:${index}`}
								className={styles.card}>
								<div className={styles.cardTop}>
									<strong>{card.name || (card.entity === 'firm' ? `Firm ${card.id}` : `Individual ${card.id}`)}</strong>
									<span>
										{card.id} • {card.entity === 'firm' ? 'Firm' : 'Individual'}
										{card.kind === 'recent' ? ' • Recently fetched' : ''}
									</span>
								</div>
								{card.statusText && <div className={styles.cardMeta}>{card.statusText}</div>}
								<div className={styles.cardScopes}>{card.sources.map((entry) => String(entry.source).toUpperCase()).join('  ') || (card.kind === 'recent' ? 'RECENT' : '')}</div>
								<div className={styles.cardSourceRow}>
									{card.sources.map((entry) => (
										<button
											key={`${card.entity}:${card.id}:${entry.source}`}
											type='button'
											className={[styles.cardSourceKeyBtn, isSelectedCardSource(card, entry.source) ? styles.cardSourceKeyBtnActive : ''].filter(Boolean).join(' ')}
											onClick={() => loadQueueSourceJson(card, entry.source)}
											disabled={activeCardSourceKey === `${card.entity}:${card.id}:${entry.source}`}>
											{entry.source}:{card.id}
										</button>
									))}
								</div>
								{shouldShowQueueCardError(card) && <div className={styles.cardError}>Fetch failed</div>}
							</div>
						))}

						{queueCards.length === 0 && queueCrdFilter.trim().length > 0 && filteredNewCrds.length > 0 && (
							<div className={styles.card}>
								<div className={styles.cardTop}>
									<strong>{filteredNewCrds[0].id}</strong>
									<span>Not cached yet • New CRD match</span>
								</div>
								<div className={styles.cardScopes}>{filteredNewCrds[0].scopes.join('  ')}</div>
								<div className={styles.cardMeta}>Use Run Queue to fetch this CRD into cache.</div>
								<button
									type='button'
									className={styles.primaryBtn}
									onClick={() => runAction('fetch-crds', [filteredNewCrds[0].id])}
									disabled={busyAction !== null}>
									{busyAction === 'fetch-crds' ? 'Running…' : `Run Queue for ${filteredNewCrds[0].id}`}
								</button>
							</div>
						)}
					</div>

					<div className={styles.leftFilterWrap}>
						<div className={styles.queueSectionTitle}>Filter Cached CRDs</div>
						<input
							value={queueCrdFilter}
							onChange={(event) => setQueueCrdFilter(event.target.value)}
							spellCheck={false}
							autoCorrect='off'
							autoCapitalize='none'
							className={styles.input}
							placeholder='Filter CRD(s), comma separated'
						/>
					</div>
				</aside>

				<section className={styles.centerPane}>
					{crawlProgress && crawlProgress.active && (
						<div className={styles.crawlBanner}>
							<div>
								<strong>Sequential Crawl:</strong> {crawlProgress.current} / {crawlProgress.total} 
								<span style={{ opacity: 0.7, marginLeft: 8 }}>({crawlProgress.query})</span>
							</div>
							<div className={styles.crawlBannerStats}>
								<span>{crawlProgress.new} new</span>
								<span>{crawlProgress.updated} updated</span>
								<span>{crawlProgress.err} errors</span>
							</div>
						</div>
					)}
					{hasCurrentRecord && (
						<>
							<div className={styles.recordHeaderRow}>
								<div className={styles.recordHeader}>{currentRecordSource ? String(currentRecordSource).toUpperCase() : 'RECORD'}</div>
								<div className={styles.recordBadge}>{currentRecordEntity ? String(currentRecordEntity).toUpperCase() : 'UNKNOWN'}</div>
							</div>
							<h2 className={styles.recordTitle}>{mainJsonLabel}</h2>
							{currentRecordId && <div className={styles.recordKeyLabel}>CRD {currentRecordId}:</div>}
							{recordUpdatedAt && <div className={styles.searchSummary}>Updated: {new Date(recordUpdatedAt).toLocaleString()}</div>}
							<div className={styles.recordDescription}>Showing recent saved files with full details.</div>
						</>
					)}

					{syncBannerText && <div className={styles.statusLine}>{syncBannerText}</div>}

					{hasCurrentRecord && (
						<div className={styles.jsonPanel}>
							{jsonRenderBusy && <div className={styles.searchSummary}>Rendering JSON…</div>}
							<pre>{codeBlock}</pre>
						</div>
					)}

					<div className={styles.searchBarWrap}>
						<div className={styles.searchTitle}>Local Name Search</div>
						<div className={styles.searchRow}>
							<input
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								spellCheck={false}
								autoCorrect='off'
								autoCapitalize='none'
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										runRedisSearch();
									}
								}}
								className={styles.input}
								placeholder='Search Redis records by name...'
							/>
							<button
								type='button'
								className={styles.primaryBtn}
								onClick={runRedisSearch}
								disabled={searchBusy}>
								{searchBusy ? 'Searching…' : 'Search'}
							</button>
						</div>
						<div className={styles.searchSummary}>{searchSummary}</div>
						{searchResults.length > 0 && (
							<>
								<button
									type='button'
									className={styles.primaryBtn}
									onClick={() => {
										const crds = searchResults.map((r) => r.id).join('\n');
										setCrdInput(crds);
									}}>
									Fetch All {searchResults.length} Results
								</button>
								<div className={styles.searchResultsList}>{searchResults.map(renderSearchResult)}</div>
							</>
						)}
					</div>
				</section>
				<aside className={`${styles.rightPane} ${rightPaneCollapsed ? styles.rightPaneCollapsed : ''}`}>
					{!rightPaneCollapsed && (
						<div className={styles.rightPaneHeader}>
							<div>
								<div className={styles.newCrdsHeader}>New CRDs</div>
								<div className={styles.detected}>Newest 20 cached CRDs</div>
							</div>
							<button
								type='button'
								className={styles.rightPaneToggle}
								onClick={() => setRightPaneCollapsed(true)}>
								Hide
							</button>
						</div>
					)}
					{rightPaneNotice && !rightPaneCollapsed && <div className={styles.rightPaneNotice}>{rightPaneNotice}</div>}
					{rightPaneCollapsed ?
						<div className={styles.rightPaneCollapsedContent}>
							<button
								type='button'
								className={styles.rightPaneToggle}
								onClick={() => setRightPaneCollapsed(false)}>
								Show
							</button>
							<div className={styles.rightPaneCollapsedSummary}>
								Newest {newCrds.length} CRD{newCrds.length === 1 ? '' : 's'}
							</div>
						</div>
					:	<div className={styles.newCrdsList}>
							{newCrds.map((item) => (
								<div
									key={`${item.type}:${item.id}:${item.scopes.join('|')}`}
									className={styles.newCrdItem}>
									<div className={styles.newCrdTop}>
										<strong>{item.id}</strong>
										<span>{item.type}</span>
									</div>
									<div className={styles.newCrdMeta}>Found {item.found} • record</div>
									<div className={styles.newCrdScopes}>{item.scopes.join('  ')}</div>
									{item.date && <div className={styles.newCrdDate}>{item.date}</div>}
								</div>
							))}
						</div>
					}
				</aside>
			</div>

			<div className={styles.hiddenValues}>
				<input
					type='text'
					value={externalRawDir}
					onChange={(event) => setExternalRawDir(event.target.value)}
				/>
			</div>
		</div>
	);
}
