'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
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
	status: 'ok' | 'error' | 'unknown';
	error?: string;
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
};

type QueueRunItem = {
	query: string;
	status: 'queued' | 'running' | 'complete' | 'nomatch' | 'error';
	elapsedSec: number;
	message?: string;
	crdCount?: number;
	detailContent?: string; // rendered HTML/text content for the card
	fetchedEntity?: {
		id: string;
		entity: 'individual' | 'firm';
		name?: string;
		[key: string]: any;
	};
};

type UrlSelectionInput = {
	entity: 'individual' | 'firm';
	id: string;
	source: SearchResultSource;
	availableSources?: SearchResultSource[];
};

function parseQueueQueries(input: string) {
	return input
		.split(/[\n,;]+/g)
		.map((value) => value.trim())
		.filter(Boolean);
}

function safeParseJson(value: unknown) {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function normalizePayloadForCleanView(payload: unknown) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

	const obj = payload as Record<string, any>;
	if (Array.isArray(obj?.hits?.hits) && obj.hits.hits.length) {
		const source = obj.hits.hits[0]?._source ?? obj.hits.hits[0];
		if (source && typeof source === 'object') {
			const parsedContent = safeParseJson((source as any).content);
			const parsedIaContent = safeParseJson((source as any).iacontent);
			const merged = {
				...(source as Record<string, any>),
				...(parsedContent && typeof parsedContent === 'object' ? (parsedContent as Record<string, any>) : {}),
				...(parsedIaContent && typeof parsedIaContent === 'object' ? (parsedIaContent as Record<string, any>) : {}),
			} as Record<string, any>;
			if (parsedContent && typeof parsedContent === 'object') delete merged.content;
			if (parsedIaContent && typeof parsedIaContent === 'object') delete merged.iacontent;
			return merged;
		}
	}

	const parsedContent = safeParseJson(obj.content);
	const parsedIaContent = safeParseJson(obj.iacontent);
	const merged = {
		...obj,
		...(parsedContent && typeof parsedContent === 'object' ? (parsedContent as Record<string, any>) : {}),
		...(parsedIaContent && typeof parsedIaContent === 'object' ? (parsedIaContent as Record<string, any>) : {}),
	} as Record<string, any>;
	if (parsedContent && typeof parsedContent === 'object') delete merged.content;
	if (parsedIaContent && typeof parsedIaContent === 'object') delete merged.iacontent;
	return merged;
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
	const [dismissedNewCrds, setDismissedNewCrds] = useState(false);
	const [newCrds, setNewCrds] = useState<Array<{ id: string; type: string; found: string; scopes: string[]; date: string }>>([]);
	const [newCrdsLoading, setNewCrdsLoading] = useState(false);
	const [newCrdsLastChecked, setNewCrdsLastChecked] = useState<string | null>(null);
	const [newCrdsDetectedCount, setNewCrdsDetectedCount] = useState(0);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [searchResults, setSearchResults] = useState<SearchResultCard[]>([]);
	const [searchSkippedCount, setSearchSkippedCount] = useState(0);
	const [queueStatusLine, setQueueStatusLine] = useState('Idle | - | queue - | elapsed 0s');
	const [queueQueryLines, setQueueQueryLines] = useState<string[]>(['target - | crd - | updated —']);
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
		inventoryTotals?: { people: number; firms: number; unique: number; source?: string };
	}>({
		shownCount: 0,
		totalCount: 0,
		totalCacheKeys: 0,
	});
	const [syncBannerText, setSyncBannerText] = useState<string | null>(null);
	const [activeCardSourceKey, setActiveCardSourceKey] = useState<string | null>(null);
	const [jsonRenderBusy, setJsonRenderBusy] = useState(false);
	const [codeBlock, setCodeBlock] = useState('');
	const [recordUpdatedAt, setRecordUpdatedAt] = useState<string | null>(null);
	const [top10Latest, setTop10Latest] = useState<Array<{ id: string; entity: 'individual' | 'firm'; fetchedAt: string; files?: number; sources?: QueueCardSourceEntry[] }>>([]);
	const mergedDetailCacheRef = useRef(new Map<string, any>());
	const jsonStringCacheRef = useRef(new Map<string, string>());

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

	// Load new CRDs on mount
	useEffect(() => {
		setNewCrdsLoading(true);
		fetch('/api/dashboard/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'list-new-crds' }),
		})
			.then((res) => res.json())
			.then((data) => {
				if (data.ok) {
					setNewCrds(data.newCrds || []);
					setNewCrdsLastChecked(data.lastChecked);
					setNewCrdsDetectedCount(data.detectedCount || 0);
				}
			})
			.catch((err) => console.error('Failed to load new CRDs:', err))
			.finally(() => setNewCrdsLoading(false));
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
				const text = JSON.stringify(payload, null, 2);
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

	const mergedQueueCards = useMemo(() => {
		const merged = new Map<string, QueueCard>();

		for (const card of queueCards) {
			merged.set(`${card.entity}:${card.id}`, card);
		}

		if (!queueCrdFilter.trim()) {
			for (const item of top10Latest.filter((entry) => (entry.sources?.length ?? 0) > 0)) {
				const key = `${item.entity}:${item.id}`;
				if (merged.has(key)) continue;
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

		return Array.from(merged.values()).sort((left, right) => {
			if (left.entity !== right.entity) return left.entity === 'individual' ? -1 : 1;
			return left.id.localeCompare(right.id);
		});
	}, [queueCards, top10Latest]);

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

	function buildQueueCardsFromFetchResults(items: any[]): QueueCard[] {
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
					: item?.status === 'ok' ? 'ok'
					: 'unknown',
				error: item?.error ? String(item.error) : undefined,
			};

			const sourceIndex = existing.sources.findIndex((entry) => entry.source === source);
			if (sourceIndex >= 0) existing.sources[sourceIndex] = nextSource;
			else existing.sources.push(nextSource);

			map.set(key, existing);
		}

		return Array.from(map.values()).sort((left, right) => {
			if (left.entity !== right.entity) return left.entity === 'individual' ? -1 : 1;
			return right.id.localeCompare(left.id);
		});
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
				setQueueMetaStats({ shownCount: 0, totalCount: 0, totalCacheKeys: 0, filteredTotalCount: 0 });
				return;
			}

			const cards = Array.isArray(payload?.cards) ? payload.cards : [];
			setQueueCards(cards as QueueCard[]);
			setQueueMetaStats({
				shownCount: Number(payload?.shownCount || cards.length || 0),
				totalCount: Number(payload?.totalCount || cards.length || 0),
				totalCacheKeys: Number(payload?.totalCacheKeys || 0),
				...(payload?.filteredTotalCount != null ? { filteredTotalCount: Number(payload.filteredTotalCount || 0) } : {}),
				...(payload?.sourceMode ? { sourceMode: String(payload.sourceMode) } : {}),
				...(payload?.inventoryTotals ? { inventoryTotals: payload.inventoryTotals } : {}),
			});
		} catch {
			// keep existing cards on load errors
		}
	}

	useEffect(() => {
		void loadQueueCardsFromRedis(queueCrdFilter);
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
		const effectiveParsedCrds = action === 'fetch-crds' ? effectiveQueries.filter((value) => /^\d{1,10}$/.test(String(value).trim())) : [];

		if (action === 'fetch-crds') {
			setQueueElapsedSec(0);
			setQueueRunItems(
				effectiveQueries.map((query, index) => ({
					query,
					status: index === 0 ? 'running' : 'queued',
					elapsedSec: 0,
				})),
			);
			setQueueStatusLine(`Searching | Queue | queue 1/${Math.max(1, effectiveQueries.length)} | elapsed 0s`);
			setQueueQueryLines(['target - | crd - | updated —', `last Starting search for "${effectiveQueries[0] || '-'}"`]);
		}

		try {
			const body =
				action === 'fetch-crds' ?
					{
						action,
						queries: effectiveQueries,
						crds: effectiveParsedCrds,
						maxCrds: 100,
					}
				: action === 'list-new-crds' ?
					{
						action,
					}
				:	{
						action,
						externalRawDir,
					};

			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});

			const payload = (await response.json()) as ApiResponse;
			setResult(payload);
			markRecordUpdatedAt((payload as any)?.at);

			if (action === 'fetch-crds') {
				mergedDetailCacheRef.current.clear();
				jsonStringCacheRef.current.clear();
				const resolution = Array.isArray((payload as any)?.resolution) ? (payload as any).resolution : [];
				const fetchedItems = Array.isArray((payload as any)?.results) ? (payload as any).results : [];
				const matched = resolution.filter((entry: any) => Number(entry?.crdCount || 0) > 0).length;
				const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
				setQueueStatusLine(`Done | ${matched}/${resolution.length || effectiveQueries.length} matched | queue ${effectiveQueries.length} | elapsed ${elapsedSec}s`);

				setQueueRunItems((current) =>
					current.map((item) => {
						const resolved = resolution.find((entry: any) => String(entry?.query || '').trim() === item.query);
						const crdCount = Number(resolved?.crdCount || 0);

						// Find fetched results for this query/CRD to extract detail info
						const fetchedResult = fetchedItems.find((result: any) => String(result?.crd || '') === item.query);
						const entityDetail = fetchedResult?.payload ? extractEntityDetailFromPayload(fetchedResult.payload, fetchedResult.type, item.query) : null;

						if (!resolved) {
							return {
								...item,
								status: 'nomatch',
								message: `${item.query} • NO MATCH`,
								fetchedEntity: entityDetail || undefined,
							};
						}

						if (crdCount > 0) {
							return {
								...item,
								status: 'complete',
								crdCount,
								message: `${item.query} • COMPLETE ${crdCount} matches`,
								fetchedEntity: entityDetail || undefined,
								detailContent: entityDetail?.status || undefined,
							};
						}

						return {
							...item,
							status: 'nomatch',
							crdCount,
							message: `${item.query} • NO MATCH`,
							fetchedEntity: entityDetail || undefined,
						};
					}),
				);

				const summary = (payload as any)?.summary;
				const successCount = Number(summary?.successCount || 0);
				const errorCount = Number(summary?.errorCount || 0);
				if (successCount > 0) {
					setSyncBannerText(`Local sync: ${successCount.toLocaleString()} new fetch${successCount === 1 ? '' : 'es'} • ${errorCount.toLocaleString()} errors`);
				} else {
					setSyncBannerText(null);
				}
				const nextQueryLines: string[] = [];
				for (const entry of resolution.slice(0, 8)) {
					const queryText = String(entry?.query || '').trim() || '-';
					const crdCount = Number(entry?.crdCount || 0);
					nextQueryLines.push(`target ${queryText} | crd ${crdCount} | updated ${crdCount > 0 ? 'yes' : 'no'}`);
				}
				nextQueryLines.push(`match F/S requests ok ${successCount} | err ${errorCount}`);
				setQueueQueryLines(nextQueryLines.length ? nextQueryLines : ['target - | crd - | updated —']);

				const nextCards = buildQueueCardsFromFetchResults(fetchedItems);
				if (nextCards.length > 0) setQueueCards(nextCards);
				void loadQueueCardsFromRedis(queueCrdFilter);

				// Auto-dismiss temporary queue cards after 3 seconds.
				window.setTimeout(() => {
					setQueueRunItems([]);
				}, 3000);
			} else if (action === 'list-new-crds') {
				// Handle refresh response
				const newCrdsData = (payload as any)?.newCrds || [];
				const detectedCount = (payload as any)?.detectedCount || 0;
				const lastChecked = (payload as any)?.lastChecked;
				setNewCrds(newCrdsData);
				setNewCrdsDetectedCount(detectedCount);
				setNewCrdsLastChecked(lastChecked);
			}
		} catch (error: any) {
			if (action === 'fetch-crds') {
				const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
				setQueueStatusLine(`Error | query failed | queue ${effectiveQueries.length} | elapsed ${elapsedSec}s`);
				setSyncBannerText(null);
				setQueueRunItems((current) =>
					current.map((item) => ({
						...item,
						status: item.status === 'complete' ? 'complete' : 'error',
						message: item.message || `${item.query} • ERROR`,
					})),
				);
			}
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

	return (
		<div className={styles.page}>
			<div className={styles.layout}>
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
						placeholder='Enter CRD(s) or name query(ies), comma separated'
					/>
					<button
						type='button'
						className={styles.primaryBtn}
						onClick={() => runAction('fetch-crds')}
						disabled={busyAction !== null || queueQueries.length === 0}>
						{busyAction === 'fetch-crds' ? 'Running…' : 'Run Queue'}
					</button>

					{(uniqueCrdCounts.individuals > 0 || uniqueCrdCounts.firms > 0) && (
						<div className={styles.uniqueCrdCount}>
							<div className={styles.countLabel}>People</div>
							<div className={styles.countValue}>{uniqueCrdCounts.individuals.toLocaleString()}</div>
							<div className={styles.countLabel}>Firms</div>
							<div className={styles.countValue}>{uniqueCrdCounts.firms.toLocaleString()}</div>
							<div className={styles.countLabel}>Unique</div>
							<div className={styles.countValue}>{uniqueCrdCounts.total.toLocaleString()}</div>
						</div>
					)}

					{queueRunItems.length > 0 && (
						<>
							<div className={styles.queueRunList}>
								{queueRunItems.map((item, index) => (
									<div
										key={`${item.query}-${index}-${item.status}`}
										className={styles.queueRunItem}>
										<div className={styles.queueRunTop}>
											<span className={styles.queueRunQuery}>{item.query}</span>
											<span className={[styles.queueRunBadge, styles['queueRunBadge_' + item.status]].filter(Boolean).join(' ')}>{item.status}</span>
										</div>
										{item.fetchedEntity && (
											<div className={styles.queueRunDetail}>
												<div className={styles.queueRunDetailId}>
													<strong>{item.fetchedEntity.id}</strong>
													<span>{item.fetchedEntity.entity === 'firm' ? 'Firm' : 'Individual'}</span>
												</div>
												{item.fetchedEntity.name && <div className={styles.queueRunDetailName}>{item.fetchedEntity.name}</div>}
												{item.detailContent && <div className={styles.queueRunDetailContent}>{item.detailContent}</div>}
											</div>
										)}
									</div>
								))}
							</div>
						</>
					)}

					<div className={styles.queueSectionTitle}>Run Queue</div>
					<div className={styles.queueMeta}>{queueMetaText}</div>
					<div className={styles.cardList}>
						{mergedQueueCards.map((card, index) => (
							<div
								key={`${card.entity}:${card.id}:${index}`}
								className={styles.card}>
								<div className={styles.cardTop}>
									<strong>{card.name || (card.entity === 'firm' ? `Firm ${card.id}` : `Individual ${card.id}`)}</strong>
									<span>
										{card.id} • {card.entity === 'firm' ? 'Firm' : 'Individual'} • {card.files} file
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
											className={styles.cardSourceKeyBtn}
											onClick={() => loadQueueSourceJson(card, entry.source)}
											disabled={activeCardSourceKey === `${card.entity}:${card.id}:${entry.source}`}>
											{entry.source}:{card.entity}:{card.id}
										</button>
									))}
								</div>
								{card.memberSince && <div className={styles.cardMeta}>Member since: {card.memberSince}</div>}
								{card.since && <div className={styles.cardMeta}>{card.kind === 'recent' ? card.since : `In industry since: ${card.since}`}</div>}
								{card.sources.some((entry) => entry.status === 'error') && <div className={styles.cardError}>One or more source fetches failed</div>}
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
							className={styles.input}
							placeholder='Filter CRD(s), comma separated'
						/>
					</div>
				</aside>

				<section className={styles.centerPane}>
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

				<aside className={styles.rightPane}>
					<div className={styles.newCrdsHeader}>New CRDs</div>
					<button
						type='button'
						className={styles.checkBtn}
						onClick={() => runAction('list-new-crds')}
						disabled={busyAction !== null}>
						{busyAction === 'list-new-crds' ? 'Refreshing…' : 'Refresh Cache'}
					</button>
					<div className={styles.detected}>{newCrdsDetectedCount} CRDs in Redis cache</div>
					<div className={styles.lastChecked}>
						Last checked:{' '}
						{newCrdsLastChecked ?
							(() => {
								const date = new Date(newCrdsLastChecked);
								const now = new Date();
								const diffMs = now.getTime() - date.getTime();
								const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
								const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
								return diffHours > 0 ? `${diffHours}h ${diffMins}m ago` : `${diffMins}m ago`;
							})()
						:	'never'}
					</div>

					{!dismissedNewCrds && (
						<div className={styles.newCrdsList}>
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
									<div className={styles.newCrdButtons}>
										{item.scopes.includes('FINRA') && (
											<button
												type='button'
												className={styles.searchSourceBtn}
												onClick={async () => {
													const entity = item.type === 'INDIVIDUAL' ? 'individual' : 'firm';
													try {
														// Try merged endpoint first
														let response = await fetch(entity === 'firm' ? `/api/finra/merged/firm/${item.id}` : `/api/finra/merged/individual/${item.id}`, {
															method: 'GET',
															headers: { Accept: 'application/json' },
															cache: 'no-store',
														});
														let detail = await response.json();

														// If not found, try the direct endpoint with search
														if (!detail?.found) {
															response = await fetch(entity === 'firm' ? `/api/finra/firm/${item.id}?merged=1` : `/api/finra/individual/${item.id}?merged=1&includePrevious=true`, {
																method: 'GET',
																headers: { Accept: 'application/json' },
																cache: 'no-store',
															});
															detail = await response.json();
														}

														// If still not found, fetch from external FINRA API via proxy
														if (!detail?.found && !detail?.basicInformation) {
															response = await fetch(`/api/search/finra/${entity}/${item.id}`, {
																method: 'GET',
																headers: { Accept: 'application/json' },
																cache: 'no-store',
															});
															if (response.ok) {
																const searchResult = await response.json();
																detail = searchResult?.doc ?? searchResult;
															}
														}

														const searchCard: SearchResultCard = {
															id: item.id,
															label: item.id,
															scope: 'finra',
															source: 'finra',
															entity,
															payload: extractPayloadFromDetail(detail, 'finra') ?? detail?.bccontent ?? detail ?? {},
														};
														setMainViewFromSearch(searchCard, 'FINRA');
													} catch (err) {
														console.error('Failed to load FINRA data:', err);
													}
												}}>
												FINRA
											</button>
										)}
										{item.scopes.includes('SEC') && (
											<button
												type='button'
												className={styles.searchSourceBtn}
												onClick={async () => {
													const entity = item.type === 'INDIVIDUAL' ? 'individual' : 'firm';
													try {
														// Try merged endpoint first
														let response = await fetch(entity === 'firm' ? `/api/finra/merged/firm/${item.id}` : `/api/finra/merged/individual/${item.id}`, {
															method: 'GET',
															headers: { Accept: 'application/json' },
															cache: 'no-store',
														});
														let detail = await response.json();

														// If not found, try the direct endpoint with search
														if (!detail?.found) {
															response = await fetch(entity === 'firm' ? `/api/finra/firm/${item.id}?merged=1` : `/api/finra/individual/${item.id}?merged=1&includePrevious=true`, {
																method: 'GET',
																headers: { Accept: 'application/json' },
																cache: 'no-store',
															});
															detail = await response.json();
														}

														// If still not found, fetch from external SEC API via proxy
														if (!detail?.found && !detail?.basicInformation) {
															response = await fetch(`/api/search/sec/${entity}/${item.id}`, {
																method: 'GET',
																headers: { Accept: 'application/json' },
																cache: 'no-store',
															});
															if (response.ok) {
																const searchResult = await response.json();
																detail = searchResult?.doc ?? searchResult;
															}
														}

														const searchCard: SearchResultCard = {
															id: item.id,
															label: item.id,
															scope: 'sec',
															source: 'sec',
															entity,
															payload: extractPayloadFromDetail(detail, 'sec') ?? detail?.iacontent ?? detail ?? {},
														};
														setMainViewFromSearch(searchCard, 'SEC');
													} catch (err) {
														console.error('Failed to load SEC data:', err);
													}
												}}>
												SEC
											</button>
										)}
									</div>
								</div>
							))}
						</div>
					)}

					<div className={styles.rightFooterRow}>
						<button
							type='button'
							className={styles.dismissBtn}
							onClick={() => setDismissedNewCrds(true)}>
							Dismiss all
						</button>
					</div>
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
