// Server-side firm connections for dashboard + graph sidebar.
// Shared Redis is multi-tenant — keep this path to mono-graph link scan only
// (plus optional FINRA_FIRM_EMPLOYMENT_FULL_SCAN). Never download multi-MB search indexes here.
// Results are cached at graph:firm-connections:{firmId} via cachedFetch.
import { getFullGraph } from '@/lib/graphStore';
import { cachedFetch } from '@/lib/simpleCache';
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
		if (relationship !== 'employed_by') continue;

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
		if (link?.isCurrent !== undefined) {
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
	// Shared Redis: only mono-graph link scan (+ optional opt-in full SCAN). Never download
	// multi-MB search indexes on this request path — that was timing out firm /connections.
	const graphEntries = await getConnectionsFromGraphStore(firmId).catch(() => [] as GraphConnectionEntry[]);
	const fullScanEntries = await getConnectionsFromFullScanIndex(firmId).catch(() => [] as GraphConnectionEntry[]);

	const current: GraphConnectionEntry[] = [];
	const previous: GraphConnectionEntry[] = [];
	const seen = new Set<string>();

	for (const entry of [...graphEntries, ...fullScanEntries]) {
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
	const cached = await cachedFetch(`graph:firm-connections:${normalizedFirmId}`, FIRM_CONNECTIONS_CACHE_TTL_SECONDS, () => computeFirmConnectionsFromGraph(normalizedFirmId));
	return cached || { currentConnections: [], previousConnections: [] };
}
