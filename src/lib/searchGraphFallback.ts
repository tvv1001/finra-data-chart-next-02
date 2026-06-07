import { getFullGraph } from '@/lib/graphStore';
import type { LocalSearchEntity, LocalSearchResponse, LocalSearchSource } from '@/lib/localSearch';

type SearchFallbackOptions = {
	limit?: number;
	offset?: number;
};

const STRICT_MATCH_QUERY_ALLOWLIST = new Set(['mason', 'bryan']);

function normalizeText(value: unknown) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function containsWholePhrase(text: string, phrase: string) {
	if (!text || !phrase) return false;
	return ` ${text} `.includes(` ${phrase} `);
}

function isIdentifierLikeQuery(value: string) {
	return /^[0-9-]+$/.test(value);
}

function isStrictMatchQuery(value: string) {
	return STRICT_MATCH_QUERY_ALLOWLIST.has(value);
}

export function collectSearchableNodeKeys(node: any) {
	const basic = node?.basicInformation || {};
	return [
		node?.id,
		node?.label,
		node?.name,
		node?.addressSearchText,
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
		node?.ind_source_id,
		node?.firm_source_id,
	]
		.map((value) => normalizeText(value))
		.filter(Boolean);
}

function getBoundedEditDistance(left: string, right: string, maxDistance: number) {
	if (left === right) return 0;
	if (!left || !right) return maxDistance + 1;
	if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		const current = [row];
		let rowMin = current[0];
		for (let col = 1; col <= right.length; col += 1) {
			const cost = left[row - 1] === right[col - 1] ? 0 : 1;
			const nextValue = Math.min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + cost);
			current[col] = nextValue;
			if (nextValue < rowMin) rowMin = nextValue;
		}
		if (rowMin > maxDistance) return maxDistance + 1;
		previous = current;
	}
	return previous[right.length];
}

function tokensFuzzyMatch(queryToken: string, candidateToken: string) {
	if (!queryToken || !candidateToken) return false;
	if (queryToken === candidateToken) return true;
	if (isIdentifierLikeQuery(queryToken) || isIdentifierLikeQuery(candidateToken)) return false;
	if (candidateToken.includes(queryToken) && queryToken.length >= 4) return true;
	if (queryToken.includes(candidateToken) && candidateToken.length >= 4) return true;
	const minLength = Math.min(queryToken.length, candidateToken.length);
	if (minLength < 4) return false;
	const maxDistance = Math.max(1, Math.floor(queryToken.length * 0.3));
	return getBoundedEditDistance(queryToken, candidateToken, maxDistance) <= maxDistance;
}

export function matchesSearchableNodeQuery(node: any, query: string) {
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return false;
	const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
	const keys = collectSearchableNodeKeys(node);
	const identifierLikeQuery = isIdentifierLikeQuery(normalizedQuery);
	const strictQuery = isStrictMatchQuery(normalizedQuery);
	if (keys.some((key) => key === normalizedQuery || containsWholePhrase(key, normalizedQuery))) return true;
	if (strictQuery) {
		return queryTokens.length > 0 && keys.some((key) => {
			const keyTokens = key.split(/\s+/).filter(Boolean);
			return queryTokens.every((qt) => keyTokens.some((kt) => kt === qt));
		});
	}
	if (!identifierLikeQuery && keys.some((key) => key.includes(normalizedQuery))) return true;
	if (queryTokens.length > 0) {
		for (const key of keys) {
			const keyTokens = key.split(/\s+/).filter(Boolean);
			if (queryTokens.every((qt) => keyTokens.some((kt) => tokensFuzzyMatch(qt, kt)))) {
				return true;
			}
		}
	}
	return false;
}

function compareNodes(left: any, right: any, query: string) {
	const normalizedQuery = normalizeText(query);
	const leftKeys = collectSearchableNodeKeys(left);
	const rightKeys = collectSearchableNodeKeys(right);
	const leftExact =
		leftKeys.some((key) => key === normalizedQuery) ? 2
		: leftKeys.some((key) => containsWholePhrase(key, normalizedQuery)) ? 1
		: 0;
	const rightExact =
		rightKeys.some((key) => key === normalizedQuery) ? 2
		: rightKeys.some((key) => containsWholePhrase(key, normalizedQuery)) ? 1
		: 0;
	if (rightExact !== leftExact) return rightExact - leftExact;
	return String(left?.id || '').localeCompare(String(right?.id || ''));
}

export async function searchGraphFallback(source: LocalSearchSource, type: LocalSearchEntity, query: string, options: SearchFallbackOptions = {}): Promise<LocalSearchResponse> {
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const graph = await getFullGraph();
	const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
	console.log('[searchGraphFallback] Graph loaded:', { hasGraph: !!graph, nodeCount: nodes.length, query });
	const group = type === 'firm' ? 'firm' : 'individual';
	const matches = nodes.filter((node) => node?.group === group && matchesSearchableNodeQuery(node, query)).sort((left, right) => compareNodes(left, right, query));
	console.log('[searchGraphFallback] Filtered nodes:', { group, totalMatches: matches.length });
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
