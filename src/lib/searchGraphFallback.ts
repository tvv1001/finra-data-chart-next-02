import { getFullGraph } from '@/lib/graphStore';
import type { LocalSearchEntity, LocalSearchResponse, LocalSearchSource } from '@/lib/localSearch';

type SearchFallbackOptions = {
	limit?: number;
	offset?: number;
};

function normalizeText(value: unknown) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function collectSearchableNodeKeys(node: any) {
	const basic = node?.basicInformation || {};
	return [
		node?.id,
		node?.label,
		node?.name,
		node?.crd,
		node?.firmId,
		node?.bdSecNumber,
		node?.iaSecNumber,
		basic?.individualId,
		basic?.firmId,
		basic?.name,
		basic?.bdSECNumber,
		basic?.iaSECNumber,
		[basic?.firstName, basic?.middleName, basic?.lastName].filter(Boolean).join(' '),
		...(Array.isArray(node?.otherNames) ? node.otherNames : []),
		...(Array.isArray(basic?.otherNames) ? basic.otherNames : []),
	]
		.map((value) => normalizeText(value))
		.filter(Boolean);
}

function matchesQuery(node: any, query: string) {
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return false;
	return collectSearchableNodeKeys(node).some((key) => key.includes(normalizedQuery));
}

function compareNodes(left: any, right: any, query: string) {
	const normalizedQuery = normalizeText(query);
	const leftKeys = collectSearchableNodeKeys(left);
	const rightKeys = collectSearchableNodeKeys(right);
	const leftExact =
		leftKeys.some((key) => key === normalizedQuery) ? 2
		: leftKeys.some((key) => key.startsWith(normalizedQuery)) ? 1
		: 0;
	const rightExact =
		rightKeys.some((key) => key === normalizedQuery) ? 2
		: rightKeys.some((key) => key.startsWith(normalizedQuery)) ? 1
		: 0;
	if (rightExact !== leftExact) return rightExact - leftExact;
	return String(left?.id || '').localeCompare(String(right?.id || ''));
}

export async function searchGraphFallback(source: LocalSearchSource, type: LocalSearchEntity, query: string, options: SearchFallbackOptions = {}): Promise<LocalSearchResponse> {
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const graph = await getFullGraph();
	const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const group = type === 'firm' ? 'firm' : 'individual';
	const matches = nodes.filter((node) => node?.group === group && matchesQuery(node, query)).sort((left, right) => compareNodes(left, right, query));
	const pageNodes = limit > 0 ? matches.slice(offset, offset + limit) : [];
	return {
		bucket: `${source}:${type}`,
		generatedAt: null,
		total: matches.length,
		hits: {
			total: matches.length,
			start: offset,
			hits: pageNodes.map((node) => ({ _id: String(node?.id || ''), _source: node })),
		},
		response: {
			numFound: matches.length,
			start: offset,
			docs: pageNodes,
		},
		results: pageNodes,
		currentPage: pageNodes,
		pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
		pageSize: limit,
	};
}
