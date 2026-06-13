'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import styles from './dashboard.module.css';

type DashboardAction = 'fetch-crds' | 'sync-and-deploy-primed';

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
};

type QueueRunItem = {
	query: string;
	status: 'queued' | 'running' | 'complete' | 'nomatch' | 'error';
	elapsedSec: number;
	message?: string;
	crdCount?: number;
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
			return {
				...(source as Record<string, any>),
				...(parsedContent && typeof parsedContent === 'object' ? (parsedContent as Record<string, any>) : {}),
				...(parsedIaContent && typeof parsedIaContent === 'object' ? (parsedIaContent as Record<string, any>) : {}),
			};
		}
	}

	const parsedContent = safeParseJson(obj.content);
	const parsedIaContent = safeParseJson(obj.iacontent);
	return {
		...obj,
		...(parsedContent && typeof parsedContent === 'object' ? (parsedContent as Record<string, any>) : {}),
		...(parsedIaContent && typeof parsedIaContent === 'object' ? (parsedIaContent as Record<string, any>) : {}),
	};
}

export default function DashboardPage() {
	const [crdInput, setCrdInput] = useState('');
	const [externalRawDir, setExternalRawDir] = useState('/home/lenny/Dev/webDev/Data-finra-sec/data/raw');
	const [busyAction, setBusyAction] = useState<DashboardAction | null>(null);
	const [result, setResult] = useState<ApiResponse | null>(null);
	const [mainJson, setMainJson] = useState<Record<string, any> | null>(null);
	const [mainJsonLabel, setMainJsonLabel] = useState('finra:individual:7362778');
	const [dismissedNewCrds, setDismissedNewCrds] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [searchResults, setSearchResults] = useState<SearchResultCard[]>([]);
	const [searchSkippedCount, setSearchSkippedCount] = useState(0);
	const [queueStatusLine, setQueueStatusLine] = useState('Idle | - | queue - | elapsed 0s');
	const [queueQueryLines, setQueueQueryLines] = useState<string[]>(['target - | crd - | updated —']);
	const [queueElapsedSec, setQueueElapsedSec] = useState(0);
	const [queueRunItems, setQueueRunItems] = useState<QueueRunItem[]>([]);
	const [queueCards, setQueueCards] = useState<QueueCard[]>([
		{ id: '7723718', files: 1, entity: 'individual', sources: [{ source: 'finra', status: 'ok' }], since: '6/14/2023' },
		{ id: '7340947', files: 1, entity: 'individual', sources: [{ source: 'finra', status: 'ok' }], since: '6/26/2021' },
		{ id: '2245410', files: 1, entity: 'individual', sources: [{ source: 'finra', status: 'ok' }], since: '6/14/1992' },
		{ id: '5572027', files: 1, entity: 'individual', sources: [{ source: 'finra', status: 'ok' }], since: '2/8/2011' },
		{ id: '2527669', files: 1, entity: 'individual', sources: [{ source: 'finra', status: 'ok' }], since: '3/15/2000' },
		{
			id: '7474983',
			files: 2,
			entity: 'individual',
			sources: [
				{ source: 'finra', status: 'ok' },
				{ source: 'sec', status: 'ok' },
			],
			since: '2/22/2022',
		},
	]);

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

	const newCrds = useMemo(
		() => [
			{ id: '8266846', type: 'INDIVIDUAL', found: '12d ago', scopes: ['FINRA', 'SEC'], date: '2026-05-13' },
			{ id: '8266825', type: 'INDIVIDUAL', found: '13d ago', scopes: ['FINRA', 'SEC'], date: '2026-05-11' },
			{ id: '8266820', type: 'INDIVIDUAL', found: '13d ago', scopes: ['FINRA', 'SEC'], date: '' },
			{ id: '8266804', type: 'INDIVIDUAL', found: '13d ago', scopes: ['FINRA'], date: '2026-05-28' },
			{ id: '341273', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
			{ id: '341272', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
			{ id: '341270', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
			{ id: '341268', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
			{ id: '341266', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
			{ id: '341265', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
			{ id: '341264', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
			{ id: '341262', type: 'FIRM', found: '12d ago', scopes: ['SEC'], date: '' },
		],
		[],
	);

	const codeBlock = useMemo(() => {
		if (mainJson) return JSON.stringify(mainJson, null, 2);
		if (result) return JSON.stringify(result, null, 2);
		return `{
  "content": {
    "basicInformation": {
      "individualId": "7362778",
      "firstName": "fazio",
      "lastName": "taffarello",
      "bcScope": "Active",
      "iaScope": "Active"
    },
    "currentEmployments": [
      {
        "firmId": "79",
        "firmName": "J.P. MORGAN SECURITIES LLC",
        "registrationBeginDate": "5/6/2025",
        "firmScope": "ACTIVE"
      }
    ]
  }
}`;
	}, [mainJson, result]);

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
		setMainJsonLabel(`${String(card.source).toUpperCase()} ${card.entity.toUpperCase()} • ${sourceLabel}`);
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
			return detail?.sources?.finra ?? detail?.finraNode ?? detail?.merged ?? null;
		}
		return detail?.sources?.sec ?? detail?.merged ?? detail?.finraNode ?? null;
	}

	async function fetchMergedDetail(card: QueueCard) {
		const route = card.entity === 'firm' ? `/api/finra/merged/firm/${card.id}` : `/api/finra/merged/individual/${card.id}`;
		const response = await fetch(route, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			cache: 'no-store',
		});
		return response.json();
	}

	async function loadQueueSourceJson(card: QueueCard, source: SearchResultSource) {
		try {
			let detail = await fetchMergedDetail(card);
			let payload = extractPayloadFromDetail(detail, source);

			if (!payload) {
				// Cache may not have been hydrated for this CRD on deployed environments.
				await fetch('/api/dashboard/refresh', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'fetch-crds',
						queries: [card.id],
						crds: [card.id],
						maxCrds: 1,
					}),
				});

				detail = await fetchMergedDetail(card);
				payload = extractPayloadFromDetail(detail, source);
			}

			if (!payload) {
				const fallback = detail?.merged ?? detail?.finraNode ?? detail?.sources?.finra ?? detail?.sources?.sec ?? null;
				if (fallback) {
					setMainJson(normalizePayloadForCleanView(fallback) as Record<string, any>);
					setMainJsonLabel(`fallback:${card.entity}:${card.id}`);
					setResult({
						ok: false,
						error: `No ${String(source).toUpperCase()} payload found for ${card.entity} ${card.id}; showing fallback payload`,
					});
					return;
				}

				setResult({ ok: false, error: `No ${String(source).toUpperCase()} payload found for ${card.entity} ${card.id} after refresh` });
				return;
			}

			setMainJson(normalizePayloadForCleanView(payload) as Record<string, any>);
			setMainJsonLabel(`${source}:${card.entity}:${card.id}`);
			syncSelectionToUrl({
				entity: card.entity,
				id: card.id,
				source,
				availableSources: card.sources.map((entry) => entry.source),
			});
		} catch (error: any) {
			setResult({ ok: false, error: error?.message || String(error) });
		}
	}

	async function runAction(action: DashboardAction) {
		setBusyAction(action);
		setResult(null);
		const startedAt = Date.now();
		if (action === 'fetch-crds') {
			setQueueElapsedSec(0);
			setQueueRunItems(
				queueQueries.map((query, index) => ({
					query,
					status: index === 0 ? 'running' : 'queued',
					elapsedSec: 0,
				})),
			);
			setQueueStatusLine(`Searching | Queue | queue 1/${Math.max(1, queueQueries.length)} | elapsed 0s`);
			setQueueQueryLines(['target - | crd - | updated —', `last Starting search for "${queueQueries[0] || '-'}"`]);
		}

		try {
			const body =
				action === 'fetch-crds' ?
					{
						action,
						queries: queueQueries,
						crds: parsedCrds,
						maxCrds: 100,
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

			if (action === 'fetch-crds') {
				const resolution = Array.isArray((payload as any)?.resolution) ? (payload as any).resolution : [];
				const matched = resolution.filter((entry: any) => Number(entry?.crdCount || 0) > 0).length;
				const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
				setQueueStatusLine(`Done | ${matched}/${resolution.length || queueQueries.length} matched | queue ${queueQueries.length} | elapsed ${elapsedSec}s`);
				setQueueRunItems((current) =>
					current.map((item) => {
						const resolved = resolution.find((entry: any) => String(entry?.query || '').trim() === item.query);
						const crdCount = Number(resolved?.crdCount || 0);
						if (!resolved) {
							return {
								...item,
								status: 'nomatch',
								message: `${item.query} • NO MATCH`,
							};
						}

						if (crdCount > 0) {
							return {
								...item,
								status: 'complete',
								crdCount,
								message: `${item.query} • COMPLETE ${crdCount} matches`,
							};
						}

						return {
							...item,
							status: 'nomatch',
							crdCount,
							message: `${item.query} • NO MATCH`,
						};
					}),
				);

				const summary = (payload as any)?.summary;
				const successCount = Number(summary?.successCount || 0);
				const errorCount = Number(summary?.errorCount || 0);
				const nextQueryLines: string[] = [];
				for (const entry of resolution.slice(0, 8)) {
					const queryText = String(entry?.query || '').trim() || '-';
					const crdCount = Number(entry?.crdCount || 0);
					nextQueryLines.push(`target ${queryText} | crd ${crdCount} | updated ${crdCount > 0 ? 'yes' : 'no'}`);
				}
				nextQueryLines.push(`match F/S requests ok ${successCount} | err ${errorCount}`);
				setQueueQueryLines(nextQueryLines.length ? nextQueryLines : ['target - | crd - | updated —']);

				const fetchedItems = Array.isArray((payload as any)?.results) ? (payload as any).results : [];
				const nextCards = buildQueueCardsFromFetchResults(fetchedItems);
				if (nextCards.length > 0) setQueueCards(nextCards);
			}
		} catch (error: any) {
			if (action === 'fetch-crds') {
				const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
				setQueueStatusLine(`Error | query failed | queue ${queueQueries.length} | elapsed ${elapsedSec}s`);
				setQueueRunItems((current) =>
					current.map((item) => ({
						...item,
						status: item.status === 'complete' ? 'complete' : 'error',
						message: item.message || `${item.query} • ERROR`,
					})),
				);
			}
			setResult({ ok: false, error: error?.message || String(error) });
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
				key={`${card.id}-${index}`}
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

					{queueRunItems.length > 0 && (
						<div className={styles.queueRunList}>
							{queueRunItems.map((item) => (
								<div
									key={item.query}
									className={styles.queueRunItem}>
									<div className={styles.queueRunTop}>
										<span className={styles.queueRunQuery}>{item.query}</span>
										<span className={`${styles.queueRunBadge} ${styles[`queueRunBadge_${item.status}`]}`}>{item.status}</span>
									</div>
									<div className={styles.queueRunMeta}>{item.message || `${item.query} • ${item.status} ${item.elapsedSec}s`}</div>
								</div>
							))}
						</div>
					)}

					<div className={styles.queueSectionTitle}>Run Queue</div>
					<div className={styles.queueMeta}>Showing recent results from 1,000 loaded files (100,316 total).</div>
					<div className={styles.cardList}>
						{queueCards.map((card) => (
							<div
								key={`${card.entity}:${card.id}`}
								className={styles.card}>
								<div className={styles.cardTop}>
									<strong>{card.id}</strong>
									<span>
										{card.entity === 'firm' ? 'Firm' : 'Individual'} • {card.files} file
									</span>
								</div>
								<div className={styles.cardScopes}>{card.sources.map((entry) => String(entry.source).toUpperCase()).join('  ')}</div>
								<div className={styles.cardSourceRow}>
									{card.sources.map((entry) => (
										<button
											key={`${card.entity}:${card.id}:${entry.source}`}
											type='button'
											className={styles.cardSourceKeyBtn}
											onClick={() => loadQueueSourceJson(card, entry.source)}>
											{entry.source}:{card.entity}:{card.id}
										</button>
									))}
								</div>
								{card.since && <div className={styles.cardMeta}>In industry since: {card.since}</div>}
								{card.sources.some((entry) => entry.status === 'error') && <div className={styles.cardError}>One or more source fetches failed</div>}
							</div>
						))}
					</div>
				</aside>

				<section className={styles.centerPane}>
					<div className={styles.recordHeader}>CURRENT RECORD</div>
					<h2 className={styles.recordTitle}>{mainJsonLabel}</h2>
					<div className={styles.recordPills}>
						<span>FINRA raw JSON</span>
						<span>SEC raw JSON</span>
					</div>

					<div className={styles.statusLine}>Local sync: 14 new • 0 updated • 0 repaired • 0 already current</div>

					<div className={styles.consoleLine}>
						{queueStatusLine}
						<br />
						{queueQueryLines.join(' • ')}
					</div>

					<div className={styles.jsonPanel}>
						<pre>{codeBlock}</pre>
					</div>

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
						{searchResults.length > 0 && <div className={styles.searchResultsList}>{searchResults.map(renderSearchResult)}</div>}
					</div>
				</section>

				<aside className={styles.rightPane}>
					<div className={styles.newCrdsHeader}>New CRDs</div>
					<button
						type='button'
						className={styles.checkBtn}
						onClick={() => runAction('sync-and-deploy-primed')}
						disabled={busyAction !== null}>
						{busyAction === 'sync-and-deploy-primed' ? 'Checking…' : 'Check for Latest'}
					</button>
					<div className={styles.detected}>48 new CRDs detected</div>
					<div className={styles.lastChecked}>Last checked: 5h ago</div>

					{!dismissedNewCrds && (
						<div className={styles.newCrdsList}>
							{newCrds.map((item) => (
								<div
									key={item.id}
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
