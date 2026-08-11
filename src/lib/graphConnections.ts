// Server-side firm connections for dashboard + graph sidebar.
// Sources (cheap → expensive):
//   1. Primed individual reverse index (Redis primed:bundle:finra-individual*)
//   2. Mono graph employed_by links (getFullGraph)
//   3. Local/search fallbacks
//   4. Opt-in full Redis SCAN (FINRA_FIRM_EMPLOYMENT_FULL_SCAN=1)
// Results are cached at graph:firm-connections:v3:{firmId} via cachedFetch.
import { getFullGraph } from '@/lib/graphStore';
import { searchLocalIndex, hasMinimumSearchQuery } from '@/lib/localSearch';
import { cachedFetch } from '@/lib/simpleCache';
import { searchGraphFallback } from '@/lib/searchGraphFallback';
import { searchDirectRedisFallback } from '@/lib/searchDirectFallback';
import { getFirmEmploymentEdgesFromFullScan } from '@/lib/firmEmploymentIndex';
import { getFirmEmploymentEdgesFromPrimed } from '@/lib/firmEmploymentFromPrimed';

export type GraphConnectionEntry = {
	individualId: string;
	name: string;
	relationship: string;
	startDate?: string;
	endDate?: string;
	isCurrent: boolean;
};

const FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60;
// Do not stick empty results for an hour — empty caches were masking recoveries.
const EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 45;

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
	}));
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
	// Primed reverse index first (covers firms missing from mono graph edges, e.g. Fisher 107342).
	// Then mono graph links + search fallbacks. Full SCAN remains opt-in.
	const [primedEntries, searchEntries, graphEntries] = await Promise.all([
		getConnectionsFromPrimedBundle(firmId).catch(() => [] as GraphConnectionEntry[]),
		getConnectionsFromSearchIndex(firmId).catch(() => [] as GraphConnectionEntry[]),
		getConnectionsFromGraphStore(firmId).catch(() => [] as GraphConnectionEntry[]),
	]);

	const fullScanEntries =
		primedEntries.length || searchEntries.length || graphEntries.length ?
			([] as GraphConnectionEntry[])
		:	await getConnectionsFromFullScanIndex(firmId).catch(() => [] as GraphConnectionEntry[]);

	const current: GraphConnectionEntry[] = [];
	const previous: GraphConnectionEntry[] = [];
	const seen = new Set<string>();

	for (const entry of [...primedEntries, ...searchEntries, ...graphEntries, ...fullScanEntries]) {
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

	// v3: primed reverse index + avoid sticky empty v1/v2 caches from broken mono-graph-only path.
	const cacheKey = `graph:firm-connections:v3:${normalizedFirmId}`;
	// Use the long TTL for cache reads; empty results are stored under a sibling short-TTL key
	// so warm recoveries are not blocked for a full hour after a cold miss.
	const cached = await cachedFetch(cacheKey, FIRM_CONNECTIONS_CACHE_TTL_SECONDS, async () => {
		const computed = await computeFirmConnectionsFromGraph(normalizedFirmId);
		const total = (computed.currentConnections?.length || 0) + (computed.previousConnections?.length || 0);
		if (total === 0) {
			// Brief empty cache via a separate key so the primary key is not poisoned for 1h.
			await cachedFetch(`${cacheKey}:empty`, EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS, async () => computed).catch(() => null);
			return computed;
		}
		return computed;
	});

	if (!cached) return { currentConnections: [], previousConnections: [] };
	return {
		currentConnections: Array.isArray(cached.currentConnections) ? cached.currentConnections : [],
		previousConnections: Array.isArray(cached.previousConnections) ? cached.previousConnections : [],
	};
}
