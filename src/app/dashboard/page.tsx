'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
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

function parseCrds(input: string) {
	return input
		.split(/[\s,]+/g)
		.map((value) => value.trim())
		.filter(Boolean)
		.filter((value) => /^\d{1,10}$/.test(value));
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

	const parsedCrds = useMemo(() => parseCrds(crdInput), [crdInput]);

	const recentCards = useMemo(
		() => [
			{ id: '7723718', files: 1, scopes: ['FINRA'], since: '6/14/2023', active: ['FINRA'] },
			{ id: '7340947', files: 1, scopes: ['FINRA'], since: '6/26/2021', active: [] },
			{ id: '2245410', files: 1, scopes: ['FINRA'], since: '6/14/1992', active: ['FINRA'] },
			{ id: '5572027', files: 1, scopes: ['FINRA'], since: '2/8/2011', active: ['FINRA'] },
			{ id: '2527669', files: 1, scopes: ['FINRA'], since: '3/15/2000', active: ['FINRA'] },
			{ id: '7474983', files: 2, scopes: ['FINRA', 'SEC'], since: '2/22/2022', active: ['FINRA', 'SEC'] },
		],
		[],
	);

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
		return `${searchResults.length} Redis result${searchResults.length === 1 ? '' : 's'} found`;
	}, [searchBusy, searchError, searchQuery, searchResults.length]);

	function setMainViewFromSearch(card: SearchResultCard, sourceLabel: string) {
		setMainJson(card.payload);
		setMainJsonLabel(`${String(card.source).toUpperCase()} ${card.entity.toUpperCase()} • ${sourceLabel}`);
	}

	async function runAction(action: DashboardAction) {
		setBusyAction(action);
		setResult(null);

		try {
			const body =
				action === 'fetch-crds' ?
					{
						action,
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
		} catch (error: any) {
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
			return;
		}

		setSearchBusy(true);
		setSearchError(null);
		setSearchResults([]);

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

			const normalize = (items: SearchResult[], source: SearchResultSource, entity: 'individual' | 'firm'): SearchResultCard[] =>
				items.map((item, index) => {
					const id = String(item?.individualId || item?.firmId || item?.crd || item?.sourceId || item?.id || `${source}-${entity}-${index}`);
					const label = String(item?.name || item?.fullName || item?.firmName || item?.firstName || item?.lastName || item?.title || 'Result').trim();
					const scope = String(item?.bcScope || item?.iaScope || item?.status || item?.registrationStatus || '').trim();
					return { id, label, scope, source, entity, payload: item };
				});

			setSearchResults([
				...normalize(getItems(finraIndividualJson), 'finra', 'individual'),
				...normalize(getItems(finraFirmJson), 'finra', 'firm'),
				...normalize(getItems(secIndividualJson), 'sec', 'individual'),
				...normalize(getItems(secFirmJson), 'sec', 'firm'),
			]);
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
					/>
					<button
						type='button'
						className={styles.primaryBtn}
						onClick={() => runAction('fetch-crds')}
						disabled={busyAction !== null || parsedCrds.length === 0}>
						{busyAction === 'fetch-crds' ? 'Running…' : 'Run Queue'}
					</button>

					<div className={styles.queueSectionTitle}>Run Queue</div>
					<div className={styles.queueMeta}>Showing recent results from 1,000 loaded files (100,316 total).</div>
					<div className={styles.cardList}>
						{recentCards.map((card) => (
							<div
								key={card.id}
								className={styles.card}>
								<div className={styles.cardTop}>
									<strong>{card.id}</strong>
									<span>Individual • {card.files} file</span>
								</div>
								<div className={styles.cardScopes}>{card.scopes.join('  ')}</div>
								<div className={styles.cardKey}>finra:individual:{card.id}</div>
								<div className={styles.cardMeta}>In industry since: {card.since}</div>
								{!!card.active.length && <div className={styles.activeTags}>● {card.active.join(' active ● ')} active</div>}
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
						target - | crd - | updated —
						<br />
						match F:0 S:0 | seeds 0 | saved 0 | sync +0/~0/!0/=0 | err 0
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
