// Server-side firm connections for dashboard + graph sidebar.
// Sources (cheap → expensive):
//   1. Primed individual reverse index (Redis primed:bundle:finra-individual*)
//   2. Mono graph employed_by links (getFullGraph)
//   3. Local/search fallbacks
//   4. Opt-in full Redis SCAN (FINRA_FIRM_EMPLOYMENT_FULL_SCAN=1)
// Results are cached at graph:firm-connections:v3:{firmId} via cachedFetch.
import { getFullGraph } from '@/lib/graphStore';
import { searchLocalIndex, hasMinimumSearchQuery } from '@/lib/localSearch';
import { searchGraphFallback } from '@/lib/searchGraphFallback';
import { searchDirectRedisFallback } from '@/lib/searchDirectFallback';
import { getFirmEmploymentEdgesFromFullScan } from '@/lib/firmEmploymentIndex';
import { getFirmEmploymentEdgesFromPrimed } from '@/lib/firmEmploymentFromPrimed';
import { getRedisClient, setStringIfValid, decompressPayload } from '@/lib/redisCache';

export type GraphConnectionEntry = {
	individualId: string;
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

async function getConnectionsFromPrimedBundle(firmId: string): Promise<GraphConnectionEntry[]> {
	const edges = await getFirmEmploymentEdgesFromPrimed(firmId).catch(() => []);
	return edges.map((edge) => ({
		individualId: edge.personCrd,
		name: edge.personName,
		relationship: edge.isCurrent ? 'Current registration' : 'Previous registration',
		startDate: edge.startDate,
		endDate: edge.isCurrent ? undefined : edge.endDate,
		isCurrent: edge.isCurrent,
		evidence: [edge.bcScope ? 'primed-bundle' : 'primed-bundle'],
		bcScope: edge.bcScope,
		iaScope: edge.iaScope,
	}));
}

function parseCachedConnectionsPayload(raw: unknown): { currentConnections: GraphConnectionEntry[]; previousConnections: GraphConnectionEntry[] } | null {
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

async function computeFirmConnectionsFromGraph(firmId: string): Promise<{ currentConnections: GraphConnectionEntry[]; previousConnections: GraphConnectionEntry[] }> {
	// Cheap → expensive. Never kick off search/primed cold-load in parallel with a hit:
	// dashboard-crds stays fast because expand uses an in-memory reverse index; we prefer
	// precomputed graph:firm-emp-adj:v1:{firmId} (O(1) Redis GET) for the same behavior.
	const merge = (lists: GraphConnectionEntry[][]) => {
		const current: GraphConnectionEntry[] = [];
		const previous: GraphConnectionEntry[] = [];
		const seen = new Set<string>();
		for (const entry of lists.flat()) {
			const dedupeKey = `${entry.individualId}:${entry.isCurrent}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			(entry.isCurrent ? current : previous).push(entry);
		}
		return { currentConnections: current, previousConnections: previous };
	};

	const primedEntries = await getConnectionsFromPrimedBundle(firmId).catch(() => [] as GraphConnectionEntry[]);
	if (primedEntries.length) return merge([primedEntries]);

	const graphEntries = await getConnectionsFromGraphStore(firmId).catch(() => [] as GraphConnectionEntry[]);
	if (graphEntries.length) return merge([graphEntries]);

	// Search can hang on cold indexes; bound it so firm pages don't 504.
	const searchEntries = await Promise.race([
		getConnectionsFromSearchIndex(firmId).catch(() => [] as GraphConnectionEntry[]),
		new Promise<GraphConnectionEntry[]>((resolve) => setTimeout(() => resolve([]), 8000)),
	]);
	if (searchEntries.length) return merge([searchEntries]);

	const fullScanEntries = await getConnectionsFromFullScanIndex(firmId).catch(() => [] as GraphConnectionEntry[]);
	return merge([fullScanEntries]);
}

export async function getFirmConnectionsFromGraph(firmId: string): Promise<{ currentConnections: GraphConnectionEntry[]; previousConnections: GraphConnectionEntry[] }> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return { currentConnections: [], previousConnections: [] };

	// v4: precomputed firm-emp-adj first (via getFirmEmploymentEdgesFromPrimed).
	// Never write empty payloads to the long-TTL key (that poisoned firm people lists for 1h).
	const cacheKey = `graph:firm-connections:v9:${normalizedFirmId}`;
	const emptyCacheKey = `${cacheKey}:empty`;
	const redis = getRedisClient();

	if (redis) {
		try {
			const hitRaw = await redis.get(cacheKey);
			const hit = parseCachedConnectionsPayload(hitRaw);
			if (hit && (hit.currentConnections.length || hit.previousConnections.length)) {
				// Validate cached entries by ensuring each referenced individual CRD
				// has a corresponding primed record in Redis (finra/sec individual bundles)
				try {
					const allCrds = Array.from(
						new Set([
							...hit.currentConnections.map((c: any) => String(c.individualId || c.personCrd || c.crd || '').trim()).filter(Boolean),
							...hit.previousConnections.map((c: any) => String(c.individualId || c.personCrd || c.crd || '').trim()).filter(Boolean),
						]),
					);
					if (allCrds.length) {
						const keys: string[] = [];
						for (const crd of allCrds) {
							keys.push(`finra:individual:${crd}`);
							keys.push(`sec:individual:${crd}`);
						}
						const values = await redis.mget(...keys).catch(() => null);
						const present = new Set<string>();
						if (Array.isArray(values)) {
							for (let i = 0; i < values.length; i++) {
								if (values[i] != null) {
									// map back to crd index
									const crdIndex = Math.floor(i / 2);
									present.add(allCrds[crdIndex]);
								}
							}
						}
						// Filter out any connections whose CRD is not present in primed redis
						hit.currentConnections = (hit.currentConnections || []).filter((c: any) => present.has(String(c.individualId || c.personCrd || c.crd || '').trim()));
						hit.previousConnections = (hit.previousConnections || []).filter((c: any) => present.has(String(c.individualId || c.personCrd || c.crd || '').trim()));
					}
				} catch (e) {
					// Validation failures are non-fatal; fall back to the cached hit as-is
					/* ignore */
				}
				return hit;
			}
			const emptyHit = await redis.get(emptyCacheKey);
			if (emptyHit != null) {
				return { currentConnections: [], previousConnections: [] };
			}
		} catch {
			// fall through to compute
		}
	}

	const fs = require('fs');
	const path = require('path');
	let localCachePath = '';
	try {
		const cacheDir = path.join(process.cwd(), 'data', 'firm-connections');
		fs.mkdirSync(cacheDir, { recursive: true });
		localCachePath = path.join(cacheDir, `${normalizedFirmId}.json`);
		if (fs.existsSync(localCachePath)) {
			const localHit = parseCachedConnectionsPayload(fs.readFileSync(localCachePath, 'utf-8'));
			if (localHit && (localHit.currentConnections.length || localHit.previousConnections.length)) {
				return localHit;
			}
		}
	} catch (e) {
		// fallback to compute
	}

	const computed = await computeFirmConnectionsFromGraph(normalizedFirmId);
	const total = (computed.currentConnections?.length || 0) + (computed.previousConnections?.length || 0);

	if (redis) {
		try {
			if (total > 0) {
				await setStringIfValid(cacheKey, JSON.stringify(computed), FIRM_CONNECTIONS_CACHE_TTL_SECONDS);
			} else {
				await setStringIfValid(emptyCacheKey, JSON.stringify({ empty: true, at: Date.now() }), EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS);
			}
		} catch {
			// best-effort cache
		}
	}

	try {
		if (localCachePath && total > 0) {
			require('fs').writeFileSync(localCachePath, JSON.stringify(computed));
		}
	} catch (e) {
		// best-effort cache
	}

	return computed;
}
