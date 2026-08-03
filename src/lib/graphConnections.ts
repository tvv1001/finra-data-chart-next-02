// Server-side reuse of the connection logic behind the interactive graph's node click/side panel
// (see collectFirmConnectionEntries + renderFirmDetail and fetchFirmBatch in src/lib/finra-graph.ts).
// That module is a large client-only D3/DOM file, so rather than importing it into API routes we
// reimplement the same two data sources it uses when a firm node is clicked/expanded in the graph:
//   1. The local search index, queried by firm CRD, which surfaces individuals whose current
//      employment record references this firm (mirrors fetchFirmBatch's "employed_by" search step).
//   2. The shared Redis-backed graph snapshot (getFullGraph()), which may already contain
//      "employed_by" links (current or previous) for this firm from prior graph activity.
// Results from both are merged so the dashboard's firm view shows the same Current Connections /
// Previous Connections a user would see by clicking the firm node in the graph.
import { getFullGraph } from '@/lib/graphStore';
import { searchLocalIndex } from '@/lib/localSearch';

export type GraphConnectionEntry = {
	individualId: string;
	name: string;
	relationship: string;
	startDate?: string;
	endDate?: string;
	isCurrent: boolean;
};

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

async function getConnectionsFromSearchIndex(firmId: string): Promise<GraphConnectionEntry[]> {
	const entries: GraphConnectionEntry[] = [];
	for (const source of ['finra', 'sec'] as const) {
		try {
			const response = await searchLocalIndex(source, 'individual', firmId, { limit: 30 });
			const hits = toArraySafe(response?.hits?.hits);
			for (const hit of hits) {
				const src = hit?._source || hit || {};
				const crd = firstNonEmpty(src.ind_source_id, src.ind_crd, src.individualId, hit?._id);
				if (!crd) continue;

				const name = firstNonEmpty([src.ind_firstname, src.ind_middlename, src.ind_lastname].filter(Boolean).join(' '), src.individualName, src.name);

				const employments = [...toArraySafe(src.ind_current_employments), ...toArraySafe(src.currentEmployments), ...toArraySafe(src.currentIAEmployments)];
				const matchedEmployment = employments.find((e: any) => firstNonEmpty(e?.firmId, e?.firm_id) === firmId);
				if (!matchedEmployment) continue;

				entries.push({
					individualId: crd,
					name,
					relationship: 'Current registration',
					startDate: firstNonEmpty(matchedEmployment?.registrationBeginDate, matchedEmployment?.startDate) || undefined,
					endDate: undefined,
					isCurrent: true,
				});
			}
		} catch {
			// Best-effort: skip this source if its index isn't available.
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

export async function getFirmConnectionsFromGraph(firmId: string): Promise<{ currentConnections: GraphConnectionEntry[]; previousConnections: GraphConnectionEntry[] }> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return { currentConnections: [], previousConnections: [] };

	const [searchEntries, graphEntries] = await Promise.all([
		getConnectionsFromSearchIndex(normalizedFirmId).catch(() => [] as GraphConnectionEntry[]),
		getConnectionsFromGraphStore(normalizedFirmId).catch(() => [] as GraphConnectionEntry[]),
	]);

	const current: GraphConnectionEntry[] = [];
	const previous: GraphConnectionEntry[] = [];
	const seen = new Set<string>();

	for (const entry of [...searchEntries, ...graphEntries]) {
		const dedupeKey = `${entry.individualId}:${entry.isCurrent}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		(entry.isCurrent ? current : previous).push(entry);
	}

	return { currentConnections: current, previousConnections: previous };
}
