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
	// Enrichment (current connections only, see enrichCurrentConnectionsWithIndividualDetail()):
	otherNames?: string[];
	address?: string;
	statusTag?: 'Broker' | 'BD Stub Only' | 'Inactive';
};

const FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// Do not stick empty results for an hour — empty caches were masking recoveries.
const EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// The shared _brokers:current|previous mirror keys are a validated, permanent cache — once an
// entry has real per-firm employment evidence it doesn't need to expire on a schedule. They are
// only ever refreshed by proven change (write-time evidence gate here, or the external-validity
// cron's change-detected updates), never by TTL expiry. `null` ttlSeconds means "no expiry" to
// setStringIfValid()/redis.set().
const MIRROR_KEY_TTL_SECONDS: number | null = null;
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

function parseBrokerIdList(raw: unknown): string[] {
	if (raw == null) return [];
	let data: any = raw;
	if (typeof data === 'string') {
		try {
			const text = data.startsWith('br:') ? decompressPayload(data) : data;
			data = JSON.parse(text);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(data)) return [];
	return data.map((id) => String(id || '').trim()).filter((id) => /^\d{1,10}$/.test(id));
}

// Priority source: the shared broker-id mirror keys ({finra|sec}:firm:{firmId}_brokers:current|previous)
// written by persistBrokerIdLists()/the legacy update_sec_brokers.mjs crawler. These are plain CRD-id
// lists (no names), but they're the fastest, most authoritative signal of who is/was connected to a
// firm — read them first and merge in graph-derived names where available.
// Local-Redis-only: this must never read from a cloud Upstash DB (per project direction), so it's a
// no-op unless USE_LOCAL_REDIS=1 has routed getRedisClient() to the local instance.
async function getConnectionsFromBrokerIdMirror(firmId: string): Promise<GraphConnectionEntry[]> {
	if (process.env.USE_LOCAL_REDIS !== '1') return [];
	const redis = getRedisClient();
	if (!redis) return [];

	const [finraCurrentRaw, finraPreviousRaw, secCurrentRaw, secPreviousRaw] = await Promise.all([
		redis.get(`finra:firm:${firmId}_brokers:current`).catch(() => null),
		redis.get(`finra:firm:${firmId}_brokers:previous`).catch(() => null),
		redis.get(`sec:firm:${firmId}_brokers:current`).catch(() => null),
		redis.get(`sec:firm:${firmId}_brokers:previous`).catch(() => null),
	]);

	const currentIds = new Set<string>([...parseBrokerIdList(finraCurrentRaw), ...parseBrokerIdList(secCurrentRaw)]);
	const previousIds = new Set<string>([...parseBrokerIdList(finraPreviousRaw), ...parseBrokerIdList(secPreviousRaw)]);
	// A person cannot be both current and previous — current wins.
	for (const id of currentIds) previousIds.delete(id);

	if (!currentIds.size && !previousIds.size) return [];

	const entries: GraphConnectionEntry[] = [];
	for (const id of currentIds) {
		entries.push({ individualId: id, name: '', relationship: 'Current registration', isCurrent: true, evidence: ['broker-id-mirror'] });
	}
	for (const id of previousIds) {
		entries.push({ individualId: id, name: '', relationship: 'Previous registration', isCurrent: false, evidence: ['broker-id-mirror'] });
	}
	return entries;
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

				// Do NOT assume a search hit is a valid connection just because the search API
				// returned it (it may have matched on a firm-name token rather than this exact
				// firm CRD, or on stale/expired data). A connection is only valid when this
				// person's own employment record actually references the firm CRD — skip
				// unverifiable hits rather than guessing (previously caused false-positive
				// "previous connections", e.g. firm 343750 showing 47 unrelated people).
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
		// Employment-record dates (registrationBeginDate/registrationEndDate) are the actual
		// "years worked at this firm" signal — mono graph links themselves rarely carry dates,
		// so prefer the matching employment record's own start/end over the link's.
		const matchedEmployment = [...currentEmployments, ...previousEmployments].find((entry) => String(firstNonEmpty(entry?.firmId, entry?.firm_id)) === String(firmId));
		const employmentStartDate = firstNonEmpty(matchedEmployment?.registrationBeginDate, matchedEmployment?.startDate);
		const employmentEndDate = firstNonEmpty(matchedEmployment?.registrationEndDate, matchedEmployment?.endDate);

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
			startDate: firstNonEmpty(employmentStartDate, startDate) || undefined,
			endDate: !isCurrent ? firstNonEmpty(employmentEndDate, endDate) || undefined : undefined,
			isCurrent,
			bcScope: firstNonEmpty(otherNode?.bcScope, otherNode?.basicInformation?.bcScope) || undefined,
			iaScope: firstNonEmpty(otherNode?.iaScope, otherNode?.basicInformation?.iaScope) || undefined,
			otherNames: extractOtherNames(otherNode),
			address: extractPrimaryAddress(otherNode, firmId),
			statusTag: computeConnectionStatusTag(otherNode, currentEmployments, isCurrent),
			evidence: ['graph-edge'],
		});
	}

	return entries;
}

// Pulls the individual's alternate/nickname list (basicInformation.otherNames or the top-level
// mirror of the same array) so cards can show "Other names" alongside the legal name.
function extractOtherNames(node: any): string[] | undefined {
	const raw = toArraySafe(node?.otherNames).length ? node.otherNames : toArraySafe(node?.basicInformation?.otherNames);
	const names = raw.map((n: unknown) => String(n || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
	return names.length ? Array.from(new Set(names)) : undefined;
}

// Best-effort branch office address for this specific firm relationship (falls back to any
// available employment record if the firmId-specific one isn't found).
function extractPrimaryAddress(node: any, firmId: string): string | undefined {
	const employments = [...toArraySafe(node?.currentEmployments), ...toArraySafe(node?.currentIAEmployments), ...toArraySafe(node?.previousEmployments), ...toArraySafe(node?.previousIAEmployments)];
	const match = employments.find((entry) => String(firstNonEmpty(entry?.firmId, entry?.firm_id)) === String(firmId)) || employments[0];
	if (!match) return undefined;
	// Some employment shapes carry a nested branchOfficeLocations[] (camelCase, from
	// FINRA/SEC detail payloads), others carry flat branch_city/branch_state/branch_zip
	// fields directly on the employment record (from search-index/graph-merge shapes).
	const branch = toArraySafe(match?.branchOfficeLocations)[0] || match;
	const city = firstNonEmpty(branch?.city, match?.branch_city, match?.branchCity);
	const state = firstNonEmpty(branch?.state, match?.branch_state, match?.branchState);
	const zip = firstNonEmpty(branch?.zipCode, branch?.zip, match?.branch_zip, match?.branchZip);
	const street = firstNonEmpty(branch?.street1, branch?.street, match?.branch_address, match?.branchAddress, match?.address);
	const parts = [street, [city, state].filter(Boolean).join(', '), zip].filter(Boolean);
	return parts.length ? parts.join(' ') : undefined;
}

// Classifies a connection as an actively-registered "Broker", a firm-affiliated but
// non-registered/sparse "BD Stub Only" record, or "Inactive" (no active registration/scope).
// Mirrors the bcScope/iaScope-driven activity signals used by isNodeInactive() in finra-graph.ts,
// but is distinct because it also considers whether the person still has an active employment
// record at this specific firm.
function computeConnectionStatusTag(node: any, currentEmployments: any[], isCurrent: boolean): GraphConnectionEntry['statusTag'] {
	const bcScope = String(firstNonEmpty(node?.bcScope, node?.basicInformation?.bcScope) || '').toLowerCase();
	const iaScope = String(firstNonEmpty(node?.iaScope, node?.basicInformation?.iaScope) || '').toLowerCase();
	const hasActiveScope = bcScope.includes('active') || iaScope.includes('active');
	if (hasActiveScope && isCurrent) return 'Broker';
	if (isCurrent && currentEmployments.length > 0) return 'BD Stub Only';
	return 'Inactive';
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

// Determine which upstream source(s) validated a connection entry from its evidence tags
// (e.g. 'search-finra', 'official-search-sec', 'matched-previous-employment' — the latter
// carries no source on its own, so we look at the sibling tag emitted alongside it).
function evidenceSources(entry: GraphConnectionEntry): Array<'finra' | 'sec'> {
	const tags = Array.isArray(entry.evidence) ? entry.evidence : [];
	const sources = new Set<'finra' | 'sec'>();
	for (const tag of tags) {
		if (/finra/i.test(tag)) sources.add('finra');
		if (/sec/i.test(tag)) sources.add('sec');
	}
	// Fall back to bcScope/iaScope presence when evidence tags are ambiguous/missing.
	if (!sources.size) {
		if (entry.bcScope) sources.add('finra');
		if (entry.iaScope) sources.add('sec');
	}
	return sources.size ? Array.from(sources) : ['finra', 'sec'];
}

// Recognized evidence tags that actually prove this individual's own employment record
// references the firm CRD in question (i.e. a real, verified connection to this specific
// firm, not just a name/token match or an unverifiable search hit). Anything without one
// of these tags — including stale 'implicit-previous-match' entries persisted by the old,
// removed fallback logic in getConnectionsFromSearchIndex() — must be excluded from the
// shared broker-id mirror keys.
const VALID_FIRM_CONNECTION_EVIDENCE = new Set(['current-employment-record', 'matched-previous-employment', 'graph-edge', 'firm-emp-adj', 'primed-bundle']);

function hasValidatedFirmConnectionEvidence(entry: GraphConnectionEntry): boolean {
	const tags = Array.isArray(entry.evidence) ? entry.evidence : [];
	return tags.some((tag) => VALID_FIRM_CONNECTION_EVIDENCE.has(tag));
}

// Write the shared broker-id list keys (finra|sec:firm:{firmId}_brokers:current|previous)
// that the sibling dashboard-crds app (and any other consumer of this shared Redis) reads.
// Only individuals whose entry carries genuine per-firm employment-record evidence (i.e.
// their own detail record actually references this firm CRD) are written here — never raw
// search hits or stale/unverifiable entries left over from older cached payloads.
async function persistBrokerIdLists(firmId: string, payload: FirmConnectionsPayload) {
	const redis = getRedisClient();
	if (!redis) return;

	const buckets: Record<'finra' | 'sec', { connected: Set<string>; previous: Set<string> }> = {
		finra: { connected: new Set(), previous: new Set() },
		sec: { connected: new Set(), previous: new Set() },
	};

	for (const entry of payload.currentConnections || []) {
		if (!hasValidatedFirmConnectionEvidence(entry)) continue;
		const id = firstNonEmpty(entry.individualId);
		if (!id || !/^\d{1,10}$/.test(id)) continue;
		for (const source of evidenceSources(entry)) buckets[source].connected.add(id);
	}
	for (const entry of payload.previousConnections || []) {
		if (!hasValidatedFirmConnectionEvidence(entry)) continue;
		const id = firstNonEmpty(entry.individualId);
		if (!id || !/^\d{1,10}$/.test(id)) continue;
		for (const source of evidenceSources(entry)) buckets[source].previous.add(id);
	}

	for (const source of ['finra', 'sec'] as const) {
		const { connected, previous } = buckets[source];
		// A person cannot be both current and previous for the same source — current wins.
		for (const id of connected) previous.delete(id);
		try {
			if (connected.size) {
				await setStringIfValid(`${source}:firm:${firmId}_brokers:current`, JSON.stringify(Array.from(connected)), MIRROR_KEY_TTL_SECONDS);
			}
			if (previous.size) {
				await setStringIfValid(`${source}:firm:${firmId}_brokers:previous`, JSON.stringify(Array.from(previous)), MIRROR_KEY_TTL_SECONDS);
			}
		} catch {
			// best-effort; shared broker-id lists are a convenience mirror, not the source of truth
		}
	}
}

// Additive-only variant for the broker-id-mirror priority branch: unions newly-validated CRDs
// (e.g. ones the official-roster backfill just proved via 'current-employment-record'/
// 'matched-previous-employment' evidence) into the existing _brokers:current|previous keys,
// but NEVER removes an existing id and never re-derives the lists from scratch. This is safe to
// call even though the mirror keys are the priority *read* source for this branch, because it
// can only grow the set, unlike persistBrokerIdLists() which fully recomputes (and can shrink) it.
async function mergeBrokerIdListsAdditive(firmId: string, payload: FirmConnectionsPayload) {
	const redis = getRedisClient();
	if (!redis) return;

	const newlyValidated: Record<'finra' | 'sec', { connected: Set<string>; previous: Set<string> }> = {
		finra: { connected: new Set(), previous: new Set() },
		sec: { connected: new Set(), previous: new Set() },
	};
	for (const entry of payload.currentConnections || []) {
		if (!hasValidatedFirmConnectionEvidence(entry)) continue;
		const id = firstNonEmpty(entry.individualId);
		if (!id || !/^\d{1,10}$/.test(id)) continue;
		for (const source of evidenceSources(entry)) newlyValidated[source].connected.add(id);
	}
	for (const entry of payload.previousConnections || []) {
		if (!hasValidatedFirmConnectionEvidence(entry)) continue;
		const id = firstNonEmpty(entry.individualId);
		if (!id || !/^\d{1,10}$/.test(id)) continue;
		for (const source of evidenceSources(entry)) newlyValidated[source].previous.add(id);
	}
	if (!newlyValidated.finra.connected.size && !newlyValidated.finra.previous.size && !newlyValidated.sec.connected.size && !newlyValidated.sec.previous.size) return;

	for (const source of ['finra', 'sec'] as const) {
		const { connected: newConnected, previous: newPrevious } = newlyValidated[source];
		if (!newConnected.size && !newPrevious.size) continue;
		try {
			const [existingConnectedRaw, existingPreviousRaw] = await Promise.all([redis.get(`${source}:firm:${firmId}_brokers:current`).catch(() => null), redis.get(`${source}:firm:${firmId}_brokers:previous`).catch(() => null)]);
			const connected = new Set<string>([...parseBrokerIdList(existingConnectedRaw), ...newConnected]);
			const previous = new Set<string>([...parseBrokerIdList(existingPreviousRaw), ...newPrevious]);
			// A person cannot be both current and previous for the same source — current wins.
			for (const id of connected) previous.delete(id);
			if (connected.size) {
				await setStringIfValid(`${source}:firm:${firmId}_brokers:current`, JSON.stringify(Array.from(connected)), MIRROR_KEY_TTL_SECONDS);
			}
			if (previous.size) {
				await setStringIfValid(`${source}:firm:${firmId}_brokers:previous`, JSON.stringify(Array.from(previous)), MIRROR_KEY_TTL_SECONDS);
			}
		} catch {
			// best-effort; shared broker-id lists are a convenience mirror, not the source of truth
		}
	}
}

export type IndividualEmploymentFirmIds = { current: string[]; previous: string[] };

// Keeps the shared broker-id mirror keys in sync for a single individual whenever their own
// detail record is (re)fetched and found to have actually changed employment — used by the
// external-validity cron's existing per-CRD discovery/update pass so mirror-key drift gets
// corrected automatically as a *side effect* of work it's already doing, without ever issuing
// a dedicated extra external API call. `oldFirmIds`/`newFirmIds` are this individual's own
// current-employer firm CRDs before/after the just-fetched record (the strongest possible
// evidence: their own record). Firms gained get added to that firm's `_brokers:current`
// mirror; firms lost get moved from `current` to `previous` for that firm (never dropped
// outright — a past employment is still evidence of a real 'previous' connection).
export async function syncBrokerIdMirrorForIndividualChange(crd: string, oldFirmIds: string[], newFirmIds: string[], sources: Array<'finra' | 'sec'> = ['finra', 'sec']): Promise<void> {
	const redis = getRedisClient();
	if (!redis) return;
	const id = firstNonEmpty(crd);
	if (!id || !/^\d{1,10}$/.test(id)) return;

	const oldSet = new Set(oldFirmIds.map((f) => firstNonEmpty(f)).filter(Boolean));
	const newSet = new Set(newFirmIds.map((f) => firstNonEmpty(f)).filter(Boolean));
	const gained = [...newSet].filter((f) => !oldSet.has(f));
	const lost = [...oldSet].filter((f) => !newSet.has(f));
	if (!gained.length && !lost.length) return;

	for (const source of sources) {
		for (const firmId of gained) {
			try {
				const [connectedRaw, previousRaw] = await Promise.all([redis.get(`${source}:firm:${firmId}_brokers:current`).catch(() => null), redis.get(`${source}:firm:${firmId}_brokers:previous`).catch(() => null)]);
				const connected = new Set(parseBrokerIdList(connectedRaw));
				const previous = new Set(parseBrokerIdList(previousRaw));
				if (connected.has(id)) continue;
				connected.add(id);
				previous.delete(id);
				await setStringIfValid(`${source}:firm:${firmId}_brokers:current`, JSON.stringify(Array.from(connected)), MIRROR_KEY_TTL_SECONDS);
				if (previous.size) await setStringIfValid(`${source}:firm:${firmId}_brokers:previous`, JSON.stringify(Array.from(previous)), MIRROR_KEY_TTL_SECONDS);
			} catch {
				// best-effort; shared broker-id lists are a convenience mirror, not the source of truth
			}
		}
		for (const firmId of lost) {
			try {
				const [connectedRaw, previousRaw] = await Promise.all([redis.get(`${source}:firm:${firmId}_brokers:current`).catch(() => null), redis.get(`${source}:firm:${firmId}_brokers:previous`).catch(() => null)]);
				const connected = new Set(parseBrokerIdList(connectedRaw));
				if (!connected.has(id)) continue;
				connected.delete(id);
				const previous = new Set(parseBrokerIdList(previousRaw));
				previous.add(id);
				await setStringIfValid(`${source}:firm:${firmId}_brokers:current`, JSON.stringify(Array.from(connected)), MIRROR_KEY_TTL_SECONDS);
				await setStringIfValid(`${source}:firm:${firmId}_brokers:previous`, JSON.stringify(Array.from(previous)), MIRROR_KEY_TTL_SECONDS);
			} catch {
				// best-effort; shared broker-id lists are a convenience mirror, not the source of truth
			}
		}
	}
	// Any firm whose mirror keys we just touched is now stale in the short-lived response cache
	// (graph:firm-connections:v10:<firmId>); drop it so the next request recomputes fresh.
	for (const firmId of [...gained, ...lost]) {
		try {
			await redis.del(firmConnectionsCacheKey(firmId));
		} catch {
			// best-effort
		}
	}
}

// Mirror a cache-hit payload into the shared broker-id keys only if they don't already
// exist, so pre-existing cached firms (validated before persistBrokerIdLists() was added,
// or whose TTL-expired mirror keys haven't been refreshed) get backfilled without forcing
// a re-fetch/re-validation on every cache-hit request.
async function backfillBrokerIdListsIfMissing(firmId: string, payload: FirmConnectionsPayload) {
	const redis = getRedisClient();
	if (!redis) return;
	const checkKeys = [`finra:firm:${firmId}_brokers:current`, `finra:firm:${firmId}_brokers:previous`, `sec:firm:${firmId}_brokers:current`, `sec:firm:${firmId}_brokers:previous`];
	let anyExists = false;
	for (const key of checkKeys) {
		try {
			const type = await redis.type(key);
			if (type && type !== 'none') {
				anyExists = true;
				break;
			}
		} catch {
			// treat as missing on error; worst case we just re-write it
		}
	}
	if (anyExists) return;
	await persistBrokerIdLists(firmId, payload);
}

async function persistFirmConnections(payload: FirmConnectionsPayload, cacheKey: string, emptyCacheKey: string, localPath: string, firmId?: string) {
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
	if (firmId && total > 0) {
		await persistBrokerIdLists(firmId, payload).catch(() => {
			// best-effort mirror; never block the primary response on this
		});
	}
}

// Unwraps the raw cached finra:individual:<crd>/sec:individual:<crd> payload, which is stored
// as the FINRA/SEC search API's response envelope ({hits:{hits:[{_source:{content:"..."}}]}})
// rather than a flat detail object — mirrors parseDetailPayload() in the individual detail route.
function unwrapCachedIndividualDetail(parsed: any): any {
	if (!parsed || typeof parsed !== 'object') return null;
	const hit = parsed?.hits?.hits?.[0]?._source;
	const raw = hit?.content ?? hit?.iacontent ?? parsed?.content ?? parsed?.iacontent;
	if (raw != null) {
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw;
		} catch {
			return null;
		}
	}
	// Already a flat detail object (e.g. from an older cache write shape).
	if (parsed?.basicInformation || parsed?.individualId || parsed?.bcScope) return parsed;
	return null;
}

// Fills in name/otherNames/address/statusTag for connection entries (current or previous) that the
// broker-id-mirror + graph-store merge couldn't resolve (e.g. person not yet hydrated into
// the mono graph). Reads only from already-cached finra:individual:<crd>/sec:individual:<crd>
// Redis keys — never triggers an external FINRA/SEC fetch, so it stays fast and respects the
// local-dev external-fetch gate. Bounded to a small batch per call to avoid large Redis scans.
async function enrichConnectionEntriesFromIndividualCache(entries: GraphConnectionEntry[], firmId: string, redis: ReturnType<typeof getRedisClient>): Promise<GraphConnectionEntry[]> {
	if (!redis || !entries.length) return entries;
	const MAX_LOOKUPS = 400;
	const needsEnrichment = entries.filter((entry) => entry.individualId && (!entry.name || !entry.statusTag)).slice(0, MAX_LOOKUPS);
	if (!needsEnrichment.length) return entries;

	const detailById = new Map<string, any>();
	await Promise.all(
		needsEnrichment.map(async (entry) => {
			const crd = entry.individualId!;
			try {
				const [finraRaw, secRaw] = await Promise.all([redis.get(`finra:individual:${crd}`).catch(() => null), redis.get(`sec:individual:${crd}`).catch(() => null)]);
				const raw = finraRaw || secRaw;
				if (!raw) return;
				const text = typeof raw === 'string' && raw.startsWith('br:') ? decompressPayload(raw) : raw;
				const rawParsed = typeof text === 'string' ? JSON.parse(text) : text;
				const detail = unwrapCachedIndividualDetail(rawParsed);
				if (detail) detailById.set(crd, detail);
			} catch {
				// best-effort; leave entry as-is
			}
		}),
	);


	if (!detailById.size) return entries;

	return entries.map((entry) => {
		const detail = entry.individualId ? detailById.get(entry.individualId) : undefined;
		if (!detail) return entry;
		const basic = detail?.basicInformation || detail || {};
		const name = firstNonEmpty(entry.name, basic?.name, [basic?.firstName, basic?.middleName, basic?.lastName].filter(Boolean).join(' '));
		const bcScope = firstNonEmpty(entry.bcScope, detail?.bcScope, basic?.bcScope) || undefined;
		const iaScope = firstNonEmpty(entry.iaScope, detail?.iaScope, basic?.iaScope) || undefined;
		const otherNames = entry.otherNames?.length ? entry.otherNames : extractOtherNames(detail);
		const address = entry.address || extractPrimaryAddress(detail, firmId);
		const currentEmployments = [...toArraySafe(detail?.currentEmployments), ...toArraySafe(detail?.currentIAEmployments)];
		const previousEmployments = [...toArraySafe(detail?.previousEmployments), ...toArraySafe(detail?.previousIAEmployments)];
		const matchedEmployment = [...currentEmployments, ...previousEmployments].find((emp) => String(firstNonEmpty(emp?.firmId, emp?.firm_id)) === String(firmId));
		const startDate = entry.startDate || firstNonEmpty(matchedEmployment?.registrationBeginDate, matchedEmployment?.startDate) || undefined;
		const endDate = !entry.isCurrent ? entry.endDate || firstNonEmpty(matchedEmployment?.registrationEndDate, matchedEmployment?.endDate) || undefined : undefined;
		const statusTag = entry.statusTag || computeConnectionStatusTag({ ...detail, bcScope, iaScope }, currentEmployments, entry.isCurrent);
		return { ...entry, name: name || entry.name, bcScope, iaScope, otherNames, address, startDate, endDate, statusTag, __employmentChecked: true, __employmentMatched: !!matchedEmployment } as GraphConnectionEntry;
	});
}

// Drops broker-id-mirror entries whose own cached detail record was just fetched (in
// enrichConnectionEntriesFromIndividualCache) and does NOT list this firm as a current/previous
// employer. This catches stale/incorrect CRDs in the shared _brokers:current|previous mirror
// keys (e.g. left over from a prior firmId typo, a since-corrected employment record, or manual
// backfill error) — real per-firm employment evidence disproves them outright. Entries whose
// detail wasn't cached (so membership couldn't be checked either way) are left untouched, since
// we can't prove them wrong.
function filterOutDisprovenBrokerMirrorEntries(entries: GraphConnectionEntry[]): GraphConnectionEntry[] {
	return entries.filter((entry) => {
		const anyEntry = entry as any;
		if (!anyEntry.__employmentChecked) return true;
		return anyEntry.__employmentMatched !== false;
	});
}

export async function getFirmConnectionsFromGraph(firmId: string): Promise<FirmConnectionsPayload> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return { currentConnections: [], previousConnections: [] };

	// Never write empty payloads to the long-TTL key (that poisoned firm people lists).
	const cacheKey = firmConnectionsCacheKey(normalizedFirmId);
	const emptyCacheKey = `${cacheKey}:empty`;
	const redis = getRedisClient();
	const local = readLocalFirmConnectionsFile(normalizedFirmId);

	// Priority source: shared broker-id mirror keys (sec:firm:{id}_brokers:current|previous,
	// finra:firm:{id}_brokers:current|previous). Cheap single-key GETs and, per project
	// direction, treated as the authoritative CRD roster ahead of every other source below.
	// Merge in graph-derived names/dates where the graph store already has that person
	// hydrated, then persist as the standard cache payload for future requests.
	const brokerMirrorEntries = await getConnectionsFromBrokerIdMirror(normalizedFirmId).catch(() => [] as GraphConnectionEntry[]);
	if (brokerMirrorEntries.length) {
		const graphEntries = await getConnectionsFromGraphStore(normalizedFirmId).catch(() => [] as GraphConnectionEntry[]);
		const graphEntryById = new Map<string, GraphConnectionEntry>();
		for (const entry of graphEntries) {
			if (entry.individualId) graphEntryById.set(entry.individualId, entry);
		}
		const enrichedEntries = brokerMirrorEntries.map((entry) => {
			const graphMatch = entry.individualId ? graphEntryById.get(entry.individualId) : undefined;
			return graphMatch ? { ...entry, ...graphMatch, evidence: [...(entry.evidence || []), ...(graphMatch.evidence || [])] } : entry;
		});
		let result = mergeGraphConnectionEntries([enrichedEntries, graphEntries]);
		result = {
			...result,
			currentConnections: await enrichConnectionEntriesFromIndividualCache(result.currentConnections, normalizedFirmId, redis),
			previousConnections: await enrichConnectionEntriesFromIndividualCache(result.previousConnections, normalizedFirmId, redis),
		};
		// Drop broker-id-mirror entries we just proved (via their own cached detail record) do
		// NOT actually list this firm as an employer — stale/incorrect CRDs in the shared mirror
		// keys, not just unhydrated ones.
		result = {
			...result,
			currentConnections: filterOutDisprovenBrokerMirrorEntries(result.currentConnections),
			previousConnections: filterOutDisprovenBrokerMirrorEntries(result.previousConnections),
		};
		// Generic name/detail backfill helper: fills in any still-missing fields on an entry from
		// a matching entry (keyed by individualId) in some other source's connection list.
		const backfillFrom = (entries: GraphConnectionEntry[], sourceById: Map<string, GraphConnectionEntry>) =>
			entries.map((entry) => {
				if (entry.name || !entry.individualId) return entry;
				const match = sourceById.get(entry.individualId);
				if (!match) return entry;
				return {
					...entry,
					name: match.name || entry.name,
					startDate: entry.startDate || match.startDate,
					endDate: entry.endDate || match.endDate,
					address: entry.address || match.address,
					otherNames: entry.otherNames?.length ? entry.otherNames : match.otherNames,
					bcScope: entry.bcScope || match.bcScope,
					iaScope: entry.iaScope || match.iaScope,
					statusTag: entry.statusTag || computeConnectionStatusTag({ bcScope: entry.bcScope || match.bcScope, iaScope: entry.iaScope || match.iaScope }, [], entry.isCurrent),
					evidence: [...(entry.evidence || []), ...(match.evidence || [])],
				};
			});
		// First, backfill from the local disk cache (data/firm-connections/{firmId}.json) — free,
		// no external call, no rate-limit risk. It's often a partial snapshot from a prior official
		// search, so it won't cover every entry, but every name it does have is real.
		if (local.payload && (result.currentConnections.some((entry) => !entry.name) || result.previousConnections.some((entry) => !entry.name))) {
			const localById = new Map<string, GraphConnectionEntry>();
			for (const entry of [...(local.payload.currentConnections || []), ...(local.payload.previousConnections || [])]) {
				if (entry.individualId) localById.set(entry.individualId, entry);
			}
			result = {
				...result,
				currentConnections: backfillFrom(result.currentConnections, localById),
				previousConnections: backfillFrom(result.previousConnections, localById),
			};
		}
		// Names still missing after the local-cache-only enrichment above mean the person isn't
		// yet cached in Redis or the mono graph. Rather than fetching each individual one-by-one
		// (which is what the client's per-node hydration already avoids doing), make a single
		// firm-level official-roster search call — it returns real names for the whole roster in
		// one paginated request — and use it purely to backfill names/otherNames/address on the
		// broker-id-mirror entries that still lack them. Skipped entirely if every entry already
		// has a name.
		let officialRosterFetched = false;
		if (result.currentConnections.some((entry) => !entry.name) || result.previousConnections.some((entry) => !entry.name)) {
			const official = await fetchOfficialFirmRoster(normalizedFirmId).catch(() => null);
			if (official) {
				officialRosterFetched = true;
				const officialById = new Map<string, GraphConnectionEntry>();
				for (const entry of [...(official.currentConnections || []), ...(official.previousConnections || [])]) {
					if (entry.individualId) officialById.set(entry.individualId, entry);
				}
				result = {
					...result,
					currentConnections: backfillFrom(result.currentConnections, officialById),
					previousConnections: backfillFrom(result.previousConnections, officialById),
				};
			}
		}
		// Strip the internal-only employment-check markers used by filterOutDisprovenBrokerMirrorEntries
		// before this ever gets serialized/persisted — they're not part of the public entry shape.
		const stripInternalMarkers = (entries: GraphConnectionEntry[]) =>
			entries.map(({ __employmentChecked, __employmentMatched, ...rest }: any) => rest as GraphConnectionEntry);
		result = {
			...result,
			currentConnections: stripInternalMarkers(result.currentConnections),
			previousConnections: stripInternalMarkers(result.previousConnections),
		};
		const payload: FirmConnectionsPayload = { ...result, source: 'broker-id-mirror' };
		// IMPORTANT: do not run this payload through persistFirmConnections()/persistBrokerIdLists().
		// Those mirror keys are exactly what we just read, and persistBrokerIdLists() only keeps
		// entries carrying validated per-firm employment evidence — re-writing this
		// 'broker-id-mirror'-tagged payload back through it would strip almost every entry and
		// destructively overwrite the very keys we're prioritizing (previously caused a live
		// firm's previous-connections mirror key to collapse from 2077 entries to 1). Only refresh
		// the short-lived v10 response cache; never touch the local disk file or the mirror keys here.
		if (redis && countFirmConnectionEntries(payload) > 0) {
			await setStringIfValid(cacheKey, JSON.stringify(payload), FIRM_CONNECTIONS_CACHE_TTL_SECONDS).catch(() => {});
		}
		// Once we've actually made a fresh official-roster call (the external API is the only
		// source that proves validated per-firm employment evidence for previously-unnamed CRDs),
		// durably persist the result so a future request never has to hit that rate-limited API
		// again for these same individuals:
		//  - additively merge any newly-validated CRDs into the _brokers:current|previous mirror
		//    keys (never shrinks them — safe unlike the full persistBrokerIdLists() recompute)
		//  - overwrite the local disk snapshot (data/firm-connections/{firmId}.json) with the
		//    fully-enriched payload (names/otherNames/address/dates), since it's now more complete
		//    than what was there before.
		if (officialRosterFetched && countFirmConnectionEntries(payload) > 0) {
			await mergeBrokerIdListsAdditive(normalizedFirmId, payload).catch(() => {});
			try {
				require('fs').writeFileSync(local.path, JSON.stringify(payload));
			} catch {
				// best-effort; the long-TTL v10 Redis cache key above is the primary durable cache
			}
		}
		return payload;
	}

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
		// Backfill the shared broker-id mirror keys for firms that were cached before
		// persistBrokerIdLists() existed (or whose mirror keys expired/were cleared).
		// Best-effort and non-blocking; only runs when the mirror keys are missing so
		// normal cache-hit requests stay fast.
		void backfillBrokerIdListsIfMissing(normalizedFirmId, cachedOfficial).catch(() => {});
		return cachedOfficial;
	}

	// Incomplete crawl/primed collections are not the roster. Refresh from the
	// official FINRA/SEC individual-by-firm search and store the result in the
	// firm-connections collection the UI already reads.
	const official = await fetchOfficialFirmRoster(normalizedFirmId).catch(() => null);
	if (official && countFirmConnectionEntries(official) > 0) {
		// A connection can also exist purely because an individual's own detail record lists
		// this firm CRD as a current/previous employer, even if the official firm-roster search
		// (which can be incomplete/paginated/rate-limited) didn't surface that person. Always
		// merge in graph-derived reverse links so the roster stays a superset, not a fallback-only source.
		const graphEntries = await getConnectionsFromGraphStore(normalizedFirmId).catch(() => [] as GraphConnectionEntry[]);
		const extras = mergeGraphConnectionEntries([
			official.currentConnections || [],
			official.previousConnections || [],
			graphEntries,
			redisHit?.currentConnections || [],
			redisHit?.previousConnections || [],
			local.payload?.currentConnections || [],
			local.payload?.previousConnections || [],
		]);
		const result: FirmConnectionsPayload = {
			...extras,
			source: OFFICIAL_FIRM_ROSTER_SOURCE,
			officialTotals: official.officialTotals,
			fetchedAt: official.fetchedAt,
		};
		await persistFirmConnections(result, cacheKey, emptyCacheKey, local.path, normalizedFirmId);
		return result;
	}

	const combined = mergeGraphConnectionEntries([redisHit?.currentConnections || [], redisHit?.previousConnections || [], local.payload?.currentConnections || [], local.payload?.previousConnections || []]);

	if (countFirmConnectionEntries(combined) > 0) {
		void backfillBrokerIdListsIfMissing(normalizedFirmId, combined).catch(() => {});
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
	await persistFirmConnections(computed, cacheKey, emptyCacheKey, local.path, normalizedFirmId);
	return computed;
}
