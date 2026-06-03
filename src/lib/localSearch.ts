import { readFile } from 'node:fs/promises';
import { getSearchIndexFilePath } from './searchDataPaths';

export type LocalSearchSource = 'finra' | 'sec';
export type LocalSearchEntity = 'individual' | 'firm';
type LocalSearchBucket = `${LocalSearchSource}:${LocalSearchEntity}`;

type LocalSearchHit = Record<string, any>;

type LocalSearchDoc = {
	id: string;
	type: LocalSearchEntity;
	source: LocalSearchSource;
	searchText: string;
	nameSearchText?: string;
	strictSearchText?: string;
	hit: LocalSearchHit;
};

type PreparedLocalSearchDoc = LocalSearchDoc & {
	normalizedNameSearchText: string;
	normalizedStrictSearchText: string;
	nameCandidates: string[];
	nameTokens: string[];
	surnameCandidates: string[];
	surnameCompactCandidates: string[];
};

type LocalSearchIndex = {
	generatedAt?: string;
	bucket?: string;
	docs?: PreparedLocalSearchDoc[];
};

type LocalSearchOptions = {
	limit?: number;
	offset?: number;
};

const MIN_SEARCH_QUERY_CHARS = 3;
const SHORT_QUERY_ALLOWLIST = new Set(['vz']);

export type LocalSearchResponse = {
	bucket: LocalSearchBucket;
	generatedAt: string | null;
	total: number;
	hits: {
		total: number;
		start: number;
		hits: Array<{ _id: string; _source: LocalSearchHit }>;
	};
	response: {
		numFound: number;
		start: number;
		docs: LocalSearchHit[];
	};
	results: LocalSearchHit[];
	currentPage: LocalSearchHit[];
	pageNumber: number;
	pageSize: number;
};

const indexPromiseCache = new Map<LocalSearchBucket, Promise<LocalSearchIndex | null>>();

function normalizeText(value: unknown) {
	return String(value || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function compactNormalizeText(value: unknown) {
	return normalizeText(value).replace(/\s+/g, '');
}

function uniqueNormalized(values: unknown[]) {
	const seen = new Set<string>();
	const normalizedValues: string[] = [];
	for (const value of values) {
		const normalized = normalizeText(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		normalizedValues.push(normalized);
	}
	return normalizedValues;
}

function arrayify(value: unknown) {
	if (Array.isArray(value)) return value;
	if (value == null || value === '') return [];
	return [value];
}

function collectNameCandidates(doc: LocalSearchDoc) {
	const hit = doc.hit || {};
	const primaryIndividualName = [hit.ind_firstname, hit.ind_middlename, hit.ind_lastname].filter(Boolean).join(' ');
	const primaryFirmName = hit.firm_name || hit.firmName || hit.organizationName || hit.organization_name || hit.companyName || hit.legalName || hit.name;
	const extraNameKeys = [
		'otherNames',
		'ind_other_names',
		'other_names',
		'previousNames',
		'previous_names',
		'priorNames',
		'prior_names',
		'formerNames',
		'former_names',
		'aliases',
		'alias',
		'aka',
		'dbaNames',
		'doingBusinessAs',
	];

	const extraNames = extraNameKeys.flatMap((key) => arrayify(hit[key]));
	return uniqueNormalized([primaryIndividualName, primaryFirmName, hit.label, hit.displayName, hit.personName, ...extraNames]);
}

function collectSurnameCandidates(doc: LocalSearchDoc) {
	const hit = doc.hit || {};
	return uniqueNormalized([hit.ind_lastname, hit.lastName, hit.lastname, hit.surname, hit.familyName]);
}

function prepareDoc(doc: LocalSearchDoc): PreparedLocalSearchDoc {
	const nameCandidates = collectNameCandidates(doc);
	const surnameCandidates = collectSurnameCandidates(doc);
	const normalizedNameSearchText = normalizeText(doc.nameSearchText || nameCandidates.join(' '));
	const normalizedStrictSearchText = normalizeText(doc.strictSearchText || doc.searchText);
	const nameTokens = Array.from(new Set(nameCandidates.flatMap((candidate) => tokenizeQuery(candidate))));
	return {
		...doc,
		normalizedNameSearchText,
		normalizedStrictSearchText,
		nameCandidates,
		nameTokens,
		surnameCandidates,
		surnameCompactCandidates: Array.from(new Set(surnameCandidates.map((candidate) => compactNormalizeText(candidate)).filter(Boolean))),
	};
}

function tokenizeQuery(query: string) {
	return normalizeText(query)
		.split(' ')
		.map((token) => token.trim())
		.filter(Boolean);
}

export function hasMinimumSearchQuery(query: string) {
	const compactQuery = normalizeText(query).replace(/\s+/g, '');
	return SHORT_QUERY_ALLOWLIST.has(compactQuery) || compactQuery.length >= MIN_SEARCH_QUERY_CHARS;
}

async function loadIndex(bucket: LocalSearchBucket): Promise<LocalSearchIndex | null> {
	if (!indexPromiseCache.has(bucket)) {
		indexPromiseCache.set(
			bucket,
			(async () => {
				try {
					const raw = await readFile(getSearchIndexFilePath(bucket), 'utf-8');
					const parsed = JSON.parse(raw) as { generatedAt?: string; bucket?: string; docs?: LocalSearchDoc[] };
					return {
						generatedAt: parsed?.generatedAt,
						bucket: parsed?.bucket,
						docs: Array.isArray(parsed?.docs) ? parsed.docs.map(prepareDoc) : [],
					};
				} catch {
					return null;
				}
			})(),
		);
	}
	return (await indexPromiseCache.get(bucket)) ?? null;
}

function getIdentifierText(doc: PreparedLocalSearchDoc) {
	const hit = doc.hit || {};
	return normalizeText(hit.ind_source_id || hit.ind_crd || hit.firm_id || hit.firmId || hit.firm_source_id || hit.bdSecNumber || hit.iaSecNumber || doc.id);
}

function containsWholePhrase(text: string, phrase: string) {
	if (!text || !phrase) return false;
	return ` ${text} `.includes(` ${phrase} `);
}

function hasStrictMatch(doc: PreparedLocalSearchDoc, normalizedQuery: string, tokens: string[]) {
	const strictText = doc.normalizedStrictSearchText;
	const identifier = getIdentifierText(doc);
	if (!strictText) return false;
	if (identifier === normalizedQuery) return true;
	if (containsWholePhrase(strictText, normalizedQuery)) return true;
	return tokens.every((token) => containsWholePhrase(strictText, token));
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
	if (candidateToken.includes(queryToken) || queryToken.includes(candidateToken)) {
		return Math.min(queryToken.length, candidateToken.length) >= 4;
	}
	const maxDistance = queryToken.length >= 8 || candidateToken.length >= 8 ? 2 : 1;
	return getBoundedEditDistance(queryToken, candidateToken, maxDistance) <= maxDistance;
}

function isStrictSurnameQuery(rawQuery: string, normalizedQuery: string) {
	const compactQuery = compactNormalizeText(normalizedQuery);
	const raw = String(rawQuery || '')
		.trim()
		.toLowerCase();
	if (compactQuery.length < 4 || /\s/.test(compactQuery)) return false;
	return compactQuery.startsWith('mc') || raw.startsWith("o'");
}

function getSurnameMatchScore(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string) {
	if (doc.type !== 'individual') return 0;
	const compactQuery = compactNormalizeText(normalizedQuery);
	if (!compactQuery) return 0;
	const strictSurnameQuery = isStrictSurnameQuery(rawQuery, normalizedQuery);
	let bestScore = 0;
	for (const candidate of doc.surnameCompactCandidates) {
		if (candidate === compactQuery) bestScore = Math.max(bestScore, strictSurnameQuery ? 420 : 240);
		else if (compactQuery.length >= 3 && candidate.startsWith(compactQuery)) bestScore = Math.max(bestScore, strictSurnameQuery ? 320 : 170);
		else if (!strictSurnameQuery && compactQuery.length >= 7 && tokensFuzzyMatch(compactQuery, candidate)) bestScore = Math.max(bestScore, 120);
	}
	return bestScore;
}

function getNameMatchScore(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	if (isStrictSurnameQuery(rawQuery, normalizedQuery)) {
		return getSurnameMatchScore(doc, rawQuery, normalizedQuery);
	}
	let bestScore = 0;
	for (const candidate of doc.nameCandidates) {
		if (candidate === normalizedQuery) bestScore = Math.max(bestScore, 260);
		else if (candidate.startsWith(normalizedQuery)) bestScore = Math.max(bestScore, 180);
		else if (candidate.includes(normalizedQuery)) bestScore = Math.max(bestScore, 130);

		const candidateTokens = tokenizeQuery(candidate);
		const matchedTokenCount = tokens.filter((token) => candidateTokens.some((candidateToken) => tokensFuzzyMatch(token, candidateToken))).length;
		if (matchedTokenCount === tokens.length && tokens.length > 0) {
			bestScore = Math.max(bestScore, 150 + matchedTokenCount * 20);
		}
	}
	return Math.max(bestScore, getSurnameMatchScore(doc, rawQuery, normalizedQuery));
}

function getSortScore(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	if (isStrictSurnameQuery(rawQuery, normalizedQuery)) {
		return getSurnameMatchScore(doc, rawQuery, normalizedQuery);
	}
	const strictText = doc.normalizedStrictSearchText;
	const nameText = doc.normalizedNameSearchText;
	const identifier = getIdentifierText(doc);
	let score = 0;
	if (identifier === normalizedQuery) score += 300;
	if (doc.id.toLowerCase().endsWith(`:${normalizedQuery}`)) score += 250;
	if (containsWholePhrase(strictText, normalizedQuery)) score += 100;
	if (nameText.startsWith(normalizedQuery)) score += 40;
	score += getNameMatchScore(doc, rawQuery, normalizedQuery, tokens);
	for (const token of tokens) {
		if (identifier === token) score += 120;
		if (containsWholePhrase(strictText, token)) score += 20;
	}
	return score;
}

function matchesQuery(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	if (!tokens.length) return false;
	if (isStrictSurnameQuery(rawQuery, normalizedQuery)) {
		return getSurnameMatchScore(doc, rawQuery, normalizedQuery) > 0;
	}
	if (getNameMatchScore(doc, rawQuery, normalizedQuery, tokens) > 0) return true;
	if (hasStrictMatch(doc, normalizedQuery, tokens)) return true;
	return tokens.every((token) => doc.nameTokens.some((candidateToken) => tokensFuzzyMatch(token, candidateToken)));
}

export async function searchLocalIndex(source: LocalSearchSource, type: LocalSearchEntity, query: string, options: LocalSearchOptions = {}): Promise<LocalSearchResponse> {
	const bucket = `${source}:${type}` as LocalSearchBucket;
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const normalizedQuery = normalizeText(query);
	const tokens = tokenizeQuery(query);
	const index = await loadIndex(bucket);
	const docs = Array.isArray(index?.docs) ? index.docs : [];
	const hasMinimumQuery = hasMinimumSearchQuery(query);

	const matches =
		!normalizedQuery || !hasMinimumQuery ?
			[]
		:	docs
				.filter((doc) => matchesQuery(doc, query, normalizedQuery, tokens))
				.sort((left, right) => {
					const scoreDiff = getSortScore(right, query, normalizedQuery, tokens) - getSortScore(left, query, normalizedQuery, tokens);
					if (scoreDiff !== 0) return scoreDiff;
					return left.id.localeCompare(right.id);
				});

	const pageDocs = limit > 0 ? matches.slice(offset, offset + limit) : [];
	const resultDocs = pageDocs.map((doc) => doc.hit || {});
	return {
		bucket,
		generatedAt: index?.generatedAt ?? null,
		total: matches.length,
		hits: {
			total: matches.length,
			start: offset,
			hits: pageDocs.map((doc) => ({ _id: doc.id, _source: doc.hit || {} })),
		},
		response: {
			numFound: matches.length,
			start: offset,
			docs: resultDocs,
		},
		results: resultDocs,
		currentPage: resultDocs,
		pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
		pageSize: limit,
	};
}
