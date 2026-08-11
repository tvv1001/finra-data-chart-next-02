// Server-side firm connections for dashboard + graph sidebar.
// Prefer cheap mono-graph link scan + local/search fallbacks. Full Redis individual SCAN is
// opt-in only (FINRA_FIRM_EMPLOYMENT_FULL_SCAN=1) because Redis is multi-tenant.
// Results are cached at graph:firm-connections:{firmId} via cachedFetch.
import { getFullGraph } from '@/lib/graphStore';
import { searchLocalIndex, hasMinimumSearchQuery } from '@/lib/localSearch';
import { cachedFetch } from '@/lib/simpleCache';
import { searchGraphFallback } from '@/lib/searchGraphFallback';
import { searchDirectRedisFallback } from '@/lib/searchDirectFallback';
import { getFirmEmploymentEdgesFromFullScan } from '@/lib/firmEmploymentIndex';

export type GraphConnectionEntry = {
	individualId: string;
	name: string;
	relationship: string;
	startDate?: string;
	endDate?: string;
	isCurrent: boolean;
};

const FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60; // 1 hour, matching the firm detail route's shared cache headers
// Avoid sticky empty caches while graph/search coverage is still warming after compression/format changes.
const EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 30;

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
	// Mirrors the fallback chain used by /api/finra/search (consumed client-side by fetchFirmBatch):
	// local static/dynamic index -> shared graph snapshot -> direct Redis record.
	// Keep this Redis-light: no external fan-out and no full individual SCAN.
	const limit = 30;
	const local = await searchLocalIndex(source, 'individual', firmId, { limit }).catch(() => null);
	if (local && local.total > 0) return toArraySafe(local?.hits?.hits).map((hit: any) => hit?._source || hit || {});

	if (!hasMinimumSearchQuery(firmId)) return [];

	const graphFallback = await searchGraphFallback(source, 'individual', firmId, { limit }).catch(() => null);
	if (graphFallback && graphFallback.total > 0) return toArraySafe(graphFallback?.hits?.hits).map((hit: any) => hit?._source || hit || {});

	const directFallback = await searchDirectRedisFallback(source, 'individual', firmId, { limit }).catch(() => null);
	if (directFallback) return toArraySafe(directFallback?.hits?.hits).map((hit: any) => hit?._source || hit || {});

	return [];
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
					});
				}
			}
		} catch {
			// Best-effort: skip this source if its index/fallback chain isn't available.
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
	if (!nodeById.has(firmNodeId)) return [];

	const entries: GraphConnectionEntry[] = [];

	for (const link of links) {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		if (!sourceId || !targetId) continue;
		if (sourceId !== firmNodeId && targetId !== firmNodeId) continue;

		// Only "employed_by" links represent individuals currently/previously employed by or
		// registered with this firm. "controls" links represent ownership and are already surfaced
		// separately via the firm's directOwners/indirectOwners sections.
		const relationship = String(link?.relationship || '').trim();
		if (relationship !== 'employed_by' && relationship !== 'previous_employed_by') continue;

		const otherId = sourceId === firmNodeId ? targetId : sourceId;
		const otherNode = nodeById.get(otherId);
		if (!otherNode || otherNode.group !== 'individual') continue;

		const crd = firstNonEmpty(otherNode.crd, otherId.replace(/^person:/, ''));
		if (!crd) continue;

		const startDate = firstNonEmpty(link?.startDate, link?.registrationBeginDate, link?.fromDate, link?.effectiveDate);
		const endDate = firstNonEmpty(link?.endDate, link?.registrationEndDate, link?.toDate);

		const currentEmployments = [...toArraySafe(otherNode.currentEmployments), ...toArraySafe(otherNode.currentIAEmployments)];
		const previousEmployments = [...toArraySafe(otherNode.previousEmployments), ...toArraySafe(otherNode.previousIAEmployments)];

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
			name: firstNonEmpty(otherNode.label),
			relationship: isCurrent ? 'Current registration' : 'Previous registration',
			startDate: startDate || undefined,
			endDate: !isCurrent && endDate ? endDate : undefined,
			isCurrent,
		});
	}

	return entries;
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
	// Prefer cheap sources first. Full individual SCAN is opt-in only (shared Redis throughput).
	const [searchEntries, graphEntries] = await Promise.all([
		getConnectionsFromSearchIndex(firmId).catch(() => [] as GraphConnectionEntry[]),
		getConnectionsFromGraphStore(firmId).catch(() => [] as GraphConnectionEntry[]),
	]);

	// Only runs when FINRA_FIRM_EMPLOYMENT_FULL_SCAN=1 — otherwise this no-ops immediately.
	const fullScanEntries = await getConnectionsFromFullScanIndex(firmId).catch(() => [] as GraphConnectionEntry[]);

	const current: GraphConnectionEntry[] = [];
	const previous: GraphConnectionEntry[] = [];
	const seen = new Set<string>();

	for (const entry of [...searchEntries, ...graphEntries, ...fullScanEntries]) {
		const dedupeKey = `${entry.individualId}:${entry.isCurrent}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		(entry.isCurrent ? current : previous).push(entry);
	}

	return { currentConnections: current, previousConnections: previous };
}

export async function getFirmConnectionsFromGraph(firmId: string): Promise<{ currentConnections: GraphConnectionEntry[]; previousConnections: GraphConnectionEntry[] }> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return { currentConnections: [], previousConnections: [] };

	// Reuse the same Upstash Redis-backed cache (cachedFetch/simpleCache.ts) that the graph and
	// firm/individual detail routes already share, so this computation isn't repeated per request.
	// Note: the cache key intentionally avoids the "finra:"/"sec:" prefixes since cachedFetch()
	// treats those prefixes as external-API service keys subject to rate-limiting/cooldown logic
	// that doesn't apply to this purely-local computation.
	//
	// Cache key versioned after brotli/graph decode fix so sticky empty `graph:firm-connections:*`
	// entries written while getFullGraph() failed to parse `br:` payloads are not reused forever.
	const cacheKey = `graph:firm-connections:v2:${normalizedFirmId}`;
	const cached = await cachedFetch(cacheKey, FIRM_CONNECTIONS_CACHE_TTL_SECONDS, async () => {
		const computed = await computeFirmConnectionsFromGraph(normalizedFirmId);
		const total = (computed.currentConnections?.length || 0) + (computed.previousConnections?.length || 0);
		if (total === 0) {
			// Short-circuit empty results with a brief in-memory-friendly TTL via a second write path:
			// return the empty payload, but callers still get correct empty arrays. Sticky hour-long
			// empty caches were masking recoveries after graph decode fixes.
			return {
				...computed,
				_cacheTtlSeconds: EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS,
			} as any;
		}
		return computed;
	});

	if (!cached) return { currentConnections: [], previousConnections: [] };
	return {
		currentConnections: Array.isArray(cached.currentConnections) ? cached.currentConnections : [],
		previousConnections: Array.isArray(cached.previousConnections) ? cached.previousConnections : [],
	};
}
