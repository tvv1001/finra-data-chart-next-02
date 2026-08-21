// Server-side firm connections for dashboard + graph sidebar.
// Sources (cheap → expensive):
//   1. Official FINRA/SEC individual-by-firm search (paginated), stored in
//      data/firm-connections/{firmId}.json — the collection the UI already reads
//   2. Cached official roster in Redis graph:firm-connections:v10:{firmId}
//   3. Primed individual reverse index / precomputed adj
//   4. Mono graph employed_by links (getFullGraph)
//   5. Local/search fallbacks and opt-in full Redis SCAN
// Results are cached at graph:firm-connections:v10:{firmId}.
import { getFullGraph } from '@/lib/graphStore';
import { searchLocalIndex, hasMinimumSearchQuery } from '@/lib/localSearch';
import { searchGraphFallback } from '@/lib/searchGraphFallback';
import { searchDirectRedisFallback } from '@/lib/searchDirectFallback';
import { getFirmEmploymentEdgesFromFullScan } from '@/lib/firmEmploymentIndex';
import { lookupFirmEmploymentEdgesFromPrimed } from '@/lib/firmEmploymentFromPrimed';
import { getRedisClient, setStringIfValid, decompressPayload } from '@/lib/redisCache';
import { fetchOfficialFirmRoster, isOfficialFirmRoster, OFFICIAL_FIRM_ROSTER_SOURCE } from '@/lib/officialFirmRoster';

export type GraphConnectionEntry = {
	individualId?: string;
	firmId?: string;
	name: string;
	relationship: string;
	startDate?: string;
	endDate?: string;
	isCurrent: boolean;
	bcScope?: string;
	iaScope?: string;
	// Evidence tags describing why this connection was inferred (e.g. 'primed', 'graph-edge', 'search-finra')
	evidence?: string[];
};

const FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// Do not stick empty results for an hour — empty caches were masking recoveries.
const EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// v10: do not treat a thin primed-bundle hit as the full roster (v9 poisoned mega-firms).
export const FIRM_CONNECTIONS_CACHE_VERSION = 10;

export function firmConnectionsCacheKey(firmId: string): string {
	return `graph:firm-connections:v${FIRM_CONNECTIONS_CACHE_VERSION}:${String(firmId || '').trim()}`;
}

export function countFirmConnectionEntries(payload: { currentConnections?: GraphConnectionEntry[]; previousConnections?: GraphConnectionEntry[] } | null | undefined): number {
	if (!payload) return 0;
	return (payload.currentConnections?.length || 0) + (payload.previousConnections?.length || 0);
}

export function connectionEntryId(entry: GraphConnectionEntry | null | undefined): string {
	return firstNonEmpty(entry?.individualId, entry?.firmId, (entry as any)?.crd);
}

export function mergeGraphConnectionEntries(lists: GraphConnectionEntry[][]): { currentConnections: GraphConnectionEntry[]; previousConnections: GraphConnectionEntry[] } {
	const current: GraphConnectionEntry[] = [];
	const previous: GraphConnectionEntry[] = [];
	const seen = new Set<string>();
	for (const entry of lists.flat()) {
		const id = connectionEntryId(entry);
		if (!id) continue;
		const kind = entry?.firmId && !entry?.individualId ? 'firm' : 'person';
		const dedupeKey = `${kind}:${id}:${entry.isCurrent ? '1' : '0'}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		(entry.isCurrent ? current : previous).push(entry);
	}
	return { currentConnections: current, previousConnections: previous };
}

function toArraySafe(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function firstNonEmpty(...values: unknown[]) {
	for (const value of values) {
		const text = String(value ?? '').trim();
		if (text) return text;
	}
	return '';
}

async function searchIndividualsForFirmWithFallback(source: 'finra' | 'sec', firmId: string): Promise<any[]> {
	const limit = 30;
	let localHits: any[] = [];

	const local = await searchLocalIndex(source, 'individual', firmId, { limit }).catch(() => null);
	if (local && local.total > 0) localHits = localHits.concat(toArraySafe(local?.hits?.hits));

	if (localHits.length < limit && hasMinimumSearchQuery(firmId)) {
		const graphFallback = await searchGraphFallback(source, 'individual', firmId, { limit }).catch(() => null);
		if (graphFallback && graphFallback.total > 0) localHits = localHits.concat(toArraySafe(graphFallback?.hits?.hits));
	}

	if (localHits.length < limit && hasMinimumSearchQuery(firmId)) {
		const directFallback = await searchDirectRedisFallback(source, 'individual', firmId, { limit }).catch(() => null);
		if (directFallback && directFallback.hits?.total > 0) localHits = localHits.concat(toArraySafe(directFallback?.hits?.hits));
	}

	let extHits: any[] = [];
	// Always fetch external if we have fewer than 20 local hits to ensure completeness for fresh DBs
	if (localHits.length < 20) {
		try {
			const maxApiRows = 100; // Both FINRA and SEC hard-fail if > 100
			const extUrl =
				source === 'finra' ?
					`https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&nrows=${maxApiRows}&includePrevious`
				:	`https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&nrows=${maxApiRows}&includePrevious`;
			const extRes = await fetch(extUrl, { cache: 'no-store' });
			const extData = await extRes.json();
			if (extData && extData.hits && extData.hits.total > 0) {
				extHits = toArraySafe(extData.hits.hits).map((hit: any) => {
					const sourceObj = hit?._source || hit || {};
					return {
						...sourceObj,
						ind_previous_employments: hit?.inner_hits?.ind_previous_employments?.hits?.hits?.map((h: any) => h._source) || [],
						ind_ia_previous_employments: hit?.inner_hits?.ind_ia_previous_employments?.hits?.hits?.map((h: any) => h._source) || [],
						ind_current_employments: hit?.inner_hits?.ind_current_employments?.hits?.hits?.map((h: any) => h._source) || sourceObj.ind_current_employments || [],
					};
				});
			}
		} catch (e) {
			// If external fetch is disabled or fails, try reading a local cached copy from data/national
			try {
				const fs = require('fs');
				const path = require('path');
				const candidates = [
					path.join(process.cwd(), 'data', 'national', `brokercheck.finra.org`, `api.brokercheck.finra.org_search_firm_${firmId}.json`),
					path.join(process.cwd(), 'data', 'national', `adviserinfo.sec.gov`, `api.adviserinfo.sec.gov_search_firm_${firmId}.json`),
				];
				for (const p of candidates) {
					if (fs.existsSync(p)) {
						const raw = fs.readFileSync(p, 'utf-8');
						let parsed: any = null;
						try {
							parsed = JSON.parse(raw);
						} catch (e2) {
							// Some files may wrap the payload; try to locate embedded JSON
							const m = raw.match(/\{\"hits\"[\s\S]*\}$/m);
							if (m) parsed = JSON.parse(m[0]);
						}
						if (parsed && parsed.hits && parsed.hits.hits) {
							extHits = toArraySafe(parsed.hits.hits).map((hit: any) => {
								const sourceObj = hit?._source || hit || {};
								return {
									...sourceObj,
									ind_previous_employments: hit?.inner_hits?.ind_previous_employments?.hits?.hits?.map((h: any) => h._source) || [],
									ind_ia_previous_employments: hit?.inner_hits?.ind_ia_previous_employments?.hits?.hits?.map((h: any) => h._source) || [],
									ind_current_employments: hit?.inner_hits?.ind_current_employments?.hits?.hits?.map((h: any) => h._source) || sourceObj.ind_current_employments || [],
								};
							});
							if (extHits.length) break;
						}
					}
				}
			} catch {
				// swallow
			}
		}
	}

	// Merge all hits, map to source, and remove duplicates
	const merged = [...localHits.map((h: any) => h?._source || h || {}), ...extHits];
	const seen = new Set<string>();
	return merged.filter((item: any) => {
		const id = item.ind_source_id || item.ind_crd || item.individualId || item.id;
		if (!id || seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

async function getConnectionsFromSearchIndex(firmId: string): Promise<GraphConnectionEntry[]> {
	const entries: GraphConnectionEntry[] = [];
	for (const source of ['finra', 'sec'] as const) {
		try {
			const hits = await searchIndividualsForFirmWithFallback(source, firmId);
			for (const src of hits) {
				const crd = firstNonEmpty(src.ind_source_id, src.ind_crd, src.individualId, src.id);
				if (!crd) continue;

				const name = firstNonEmpty([src.ind_firstname, src.ind_middlename, src.ind_lastname].filter(Boolean).join(' '), src.individualName, src.name);

				const currentEmployments = [...toArraySafe(src.ind_current_employments), ...toArraySafe(src.currentEmployments), ...toArraySafe(src.currentIAEmployments)];
				const previousEmployments = [
					...toArraySafe(src.ind_previous_employments),
					...toArraySafe(src.ind_ia_previous_employments),
					...toArraySafe(src.previousEmployments),
					...toArraySafe(src.previousIAEmployments),
				];

				const matchedCurrent = currentEmployments.find((e: any) => firstNonEmpty(e?.firmId, e?.firm_id) === firmId);
				if (matchedCurrent) {
					entries.push({
						individualId: crd,
						name,
						relationship: 'Current registration',
						startDate: firstNonEmpty(matchedCurrent?.registrationBeginDate, matchedCurrent?.startDate) || undefined,
						endDate: undefined,
						isCurrent: true,
						evidence: [`search-${source}`, 'current-employment-record'],
					});
					continue;
				}

				const matchedPrevious = previousEmployments.find((e: any) => firstNonEmpty(e?.firmId, e?.firm_id) === firmId);
				if (matchedPrevious) {
					entries.push({
						individualId: crd,
						name,
						relationship: 'Previous registration',
						startDate: firstNonEmpty(matchedPrevious?.registrationBeginDate, matchedPrevious?.startDate) || undefined,
						endDate: firstNonEmpty(matchedPrevious?.registrationEndDate, matchedPrevious?.endDate) || undefined,
						isCurrent: false,
						evidence: [`search-${source}`, 'matched-previous-employment'],
					});
					continue;
				}

				// External API hits often omit previousEmployments but return the hit because they matched the firm= ID.
				// If they reached here, they must be a previous registration.
				entries.push({
					individualId: crd,
					name,
					relationship: 'Previous registration',
					startDate: undefined,
					endDate: undefined,
					isCurrent: false,
					evidence: [`search-${source}`, 'implicit-previous-match'],
				});
			}
		} catch {
			// Best-effort
		}
	}
	return entries;
}

async function getConnectionsFromGraphStore(firmId: string): Promise<GraphConnectionEntry[]> {
	let graph: any;
	try {
		graph = await getFullGraph();
	} catch {
		return [];
	}

	const nodes: any[] = toArraySafe(graph?.nodes);
	const links: any[] = toArraySafe(graph?.links);
	if (!nodes.length || !links.length) return [];

	const firmNodeId = `firm:${firmId}`;
	const nodeById = new Map<string, any>();
	for (const node of nodes) {
		const id = node?.id ? String(node.id) : '';
		if (id) nodeById.set(id, node);
	}
	if (!nodeById.has(firmNodeId)) {
		// Still scan links — mono graph may omit the firm node while links exist after partial merges.
	}

	const entries: GraphConnectionEntry[] = [];

	for (const link of links) {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		if (!sourceId || !targetId) continue;
		if (sourceId !== firmNodeId && targetId !== firmNodeId) continue;

		const relationship = String(link?.relationship || '').trim();
		if (relationship !== 'employed_by' && relationship !== 'previous_employed_by') continue;

		const otherId = sourceId === firmNodeId ? targetId : sourceId;
		const otherNode = nodeById.get(otherId);
		const crd = firstNonEmpty(otherNode?.crd, otherId.replace(/^person:/, ''));
		if (!crd || !otherId.startsWith('person:')) continue;
		if (otherNode && otherNode.group && otherNode.group !== 'individual') continue;

		const startDate = firstNonEmpty(link?.startDate, link?.registrationBeginDate, link?.fromDate, link?.effectiveDate);
		const endDate = firstNonEmpty(link?.endDate, link?.registrationEndDate, link?.toDate);

		const currentEmployments = [...toArraySafe(otherNode?.currentEmployments), ...toArraySafe(otherNode?.currentIAEmployments)];
		const previousEmployments = [...toArraySafe(otherNode?.previousEmployments), ...toArraySafe(otherNode?.previousIAEmployments)];

		let isCurrent: boolean;
		if (relationship === 'previous_employed_by') {
			isCurrent = false;
		} else if (link?.isCurrent !== undefined) {
			isCurrent = Boolean(link.isCurrent);
		} else if (currentEmployments.some((entry) => firstNonEmpty(entry?.firmId, entry?.firm_id) === firmId)) {
			isCurrent = true;
		} else if (previousEmployments.some((entry) => firstNonEmpty(entry?.firmId, entry?.firm_id) === firmId)) {
			isCurrent = false;
		} else {
			isCurrent = !endDate;
		}

		entries.push({
			individualId: crd,
			name: firstNonEmpty(otherNode?.label),
			relationship: isCurrent ? 'Current registration' : 'Previous registration',
			startDate: startDate || undefined,
			endDate: !isCurrent && endDate ? endDate : undefined,
			isCurrent,
			evidence: ['graph-edge'],
		});
	}

	return entries;
}

async function getConnectionsFromPrimedBundle(firmId: string): Promise<{ entries: GraphConnectionEntry[]; source: 'adj' | 'bundle' | 'none' }> {
	const lookup = await lookupFirmEmploymentEdgesFromPrimed(firmId).catch(() => ({ edges: [], source: 'none' as const }));
	return {
		source: lookup.source,
		entries: lookup.edges.map((edge) => ({
			individualId: edge.personCrd,
			name: edge.personName,
			relationship: edge.isCurrent ? 'Current registration' : 'Previous registration',
			startDate: edge.startDate,
			endDate: edge.isCurrent ? undefined : edge.endDate,
			isCurrent: edge.isCurrent,
			evidence: [lookup.source === 'adj' ? 'firm-emp-adj' : 'primed-bundle'],
			bcScope: edge.bcScope,
			iaScope: edge.iaScope,
		})),
	};
}

type FirmConnectionsPayload = {
	currentConnections: GraphConnectionEntry[];
	previousConnections: GraphConnectionEntry[];
	source?: string;
	officialTotals?: { finra?: number; sec?: number };
	fetchedAt?: string;
};

function parseCachedConnectionsPayload(raw: unknown): FirmConnectionsPayload | null {
	if (raw == null) return null;
	let data: any = raw;
	if (typeof data === 'string') {
		try {
			const text = data.startsWith('br:') ? decompressPayload(data) : data;
			data = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (!data || typeof data !== 'object') return null;
	return {
		currentConnections: Array.isArray(data.currentConnections) ? data.currentConnections : [],
		previousConnections: Array.isArray(data.previousConnections) ? data.previousConnections : [],
		source: typeof data.source === 'string' ? data.source : undefined,
		officialTotals: data.officialTotals && typeof data.officialTotals === 'object' ? data.officialTotals : undefined,
		fetchedAt: typeof data.fetchedAt === 'string' ? data.fetchedAt : undefined,
	};
}

async function getConnectionsFromFullScanIndex(firmId: string): Promise<GraphConnectionEntry[]> {
	const edges = await getFirmEmploymentEdgesFromFullScan(firmId).catch(() => []);
	return edges.map((edge) => ({
		individualId: edge.personCrd,
		name: edge.personName,
		relationship: edge.isCurrent ? 'Current registration' : 'Previous registration',
		startDate: edge.startDate,
		endDate: edge.isCurrent ? undefined : edge.endDate,
		isCurrent: edge.isCurrent,
	}));
}

async function computeFirmConnectionsFromGraph(firmId: string): Promise<FirmConnectionsPayload> {
	const official = await fetchOfficialFirmRoster(firmId).catch(() => null);
	if (official && countFirmConnectionEntries(official) > 0) return official;

	// Cheap → expensive fallbacks when official search is unavailable.
	// Trust precomputed adj as complete. A primed-bundle hit is only the people
	// present in that snapshot — never treat a 1-person bundle match as the roster.
	const primed = await getConnectionsFromPrimedBundle(firmId).catch(() => ({ entries: [] as GraphConnectionEntry[], source: 'none' as const }));
	if (primed.source === 'adj') return mergeGraphConnectionEntries([primed.entries]);

	const graphEntries = await getConnectionsFromGraphStore(firmId).catch(() => [] as GraphConnectionEntry[]);
	if (graphEntries.length) return mergeGraphConnectionEntries([primed.entries, graphEntries]);

	// Search can hang on cold indexes; bound it so firm pages don't 504.
	const searchEntries = await Promise.race([
		getConnectionsFromSearchIndex(firmId).catch(() => [] as GraphConnectionEntry[]),
		new Promise<GraphConnectionEntry[]>((resolve) => setTimeout(() => resolve([]), 8000)),
	]);
	if (searchEntries.length || primed.entries.length) return mergeGraphConnectionEntries([primed.entries, searchEntries]);

	const fullScanEntries = await getConnectionsFromFullScanIndex(firmId).catch(() => [] as GraphConnectionEntry[]);
	return mergeGraphConnectionEntries([fullScanEntries]);
}

function readLocalFirmConnectionsFile(firmId: string): { payload: FirmConnectionsPayload | null; path: string } {
	const fs = require('fs');
	const path = require('path');
	const localCachePath = path.join(process.cwd(), 'data', 'firm-connections', `${firmId}.json`);
	try {
		fs.mkdirSync(path.dirname(localCachePath), { recursive: true });
		if (fs.existsSync(localCachePath)) {
			const localHit = parseCachedConnectionsPayload(fs.readFileSync(localCachePath, 'utf-8'));
			if (localHit && countFirmConnectionEntries(localHit) > 0) {
				return { payload: localHit, path: localCachePath };
			}
		}
	} catch {
		// fallback to compute
	}
	return { payload: null, path: localCachePath };
}

async function persistFirmConnections(payload: FirmConnectionsPayload, cacheKey: string, emptyCacheKey: string, localPath: string) {
	const total = countFirmConnectionEntries(payload);
	const redis = getRedisClient();
	if (redis) {
		try {
			if (total > 0) {
				await setStringIfValid(cacheKey, JSON.stringify(payload), FIRM_CONNECTIONS_CACHE_TTL_SECONDS);
			} else {
				await setStringIfValid(emptyCacheKey, JSON.stringify({ empty: true, at: Date.now() }), EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS);
			}
		} catch {
			// best-effort cache
		}
	}
	try {
		if (localPath && total > 0) {
			require('fs').writeFileSync(localPath, JSON.stringify(payload));
		}
	} catch {
		// best-effort cache
	}
}

export async function getFirmConnectionsFromGraph(firmId: string): Promise<FirmConnectionsPayload> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return { currentConnections: [], previousConnections: [] };

	// Never write empty payloads to the long-TTL key (that poisoned firm people lists).
	const cacheKey = firmConnectionsCacheKey(normalizedFirmId);
	const emptyCacheKey = `${cacheKey}:empty`;
	const redis = getRedisClient();
	const local = readLocalFirmConnectionsFile(normalizedFirmId);

	let redisHit: FirmConnectionsPayload | null = null;
	if (redis) {
		try {
			redisHit = parseCachedConnectionsPayload(await redis.get(cacheKey));
			if (redisHit && countFirmConnectionEntries(redisHit) === 0) redisHit = null;
		} catch {
			redisHit = null;
		}
	}

	const cachedOfficial = isOfficialFirmRoster(redisHit) ? redisHit : isOfficialFirmRoster(local.payload) ? local.payload : null;
	if (cachedOfficial && countFirmConnectionEntries(cachedOfficial) > 0) {
		return cachedOfficial;
	}

	// Incomplete crawl/primed collections are not the roster. Refresh from the
	// official FINRA/SEC individual-by-firm search and store the result in the
	// firm-connections collection the UI already reads.
	const official = await fetchOfficialFirmRoster(normalizedFirmId).catch(() => null);
	if (official && countFirmConnectionEntries(official) > 0) {
		const extras = mergeGraphConnectionEntries([
			official.currentConnections || [],
			official.previousConnections || [],
			redisHit?.currentConnections || [],
			redisHit?.previousConnections || [],
			local.payload?.currentConnections || [],
			local.payload?.previousConnections || [],
		]);
		const result: FirmConnectionsPayload = {
			...extras,
			source: OFFICIAL_FIRM_ROSTER_SOURCE,
			meta: { updatedAt: new Date().toISOString(), ttlSeconds: 24 * 60 * 60, generatedAt: new Date().toISOString() },
			generatedAt: new Date().toISOString(),
		};
		await persistFirmConnections(result, cacheKey, emptyCacheKey, local.path);
		return result;
	}

	const combined = mergeGraphConnectionEntries([redisHit?.currentConnections || [], redisHit?.previousConnections || [], local.payload?.currentConnections || [], local.payload?.previousConnections || []]);

	if (countFirmConnectionEntries(combined) > 0) {
		return combined;
	}

	if (redis) {
		try {
			const emptyHit = await redis.get(emptyCacheKey);
			if (emptyHit != null) {
				return { currentConnections: [], previousConnections: [] };
			}
		} catch {
			// fall through to compute
		}
	}

	const computed = await computeFirmConnectionsFromGraph(normalizedFirmId);
	await persistFirmConnections(computed, cacheKey, emptyCacheKey, local.path);
	return computed;
}
