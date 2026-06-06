import { readFile } from 'node:fs/promises';
import { getSearchIndexFilePath } from './searchDataPaths';

async function fetchFromRedis(bucket: string): Promise<any | null> {
	const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
	const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!redisUrl || !redisToken) {
		return null;
	}

	try {
		const response = await fetch(redisUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${redisToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(['GET', `search:indexes:${bucket}`]),
		});

		if (!response.ok) {
			return null;
		}

		const apiResponse = await response.json();
		const value = apiResponse?.result;
		if (!value) return null;

		return JSON.parse(value);
	} catch (err) {
		console.error(`[localSearch] Failed to fetch index from Redis for ${bucket}:`, err instanceof Error ? err.message : String(err));
		return null;
	}
}

export type LocalSearchSource = 'finra' | 'sec';
export type LocalSearchEntity = 'individual' | 'firm';
type LocalSearchBucket = `${LocalSearchSource}:${LocalSearchEntity}`;

export type LocalSearchHit = Record<string, any>;
export type LocalSearchDoc = {
	id: string;
	type: LocalSearchEntity;
	source: LocalSearchSource;
	nameSearchText: string;
	strictSearchText: string;
	searchText: string;
	hit: LocalSearchHit;
};

type PreparedLocalSearchDoc = LocalSearchDoc & {
	primaryNameSearchText: string;
	normalizedNameSearchText: string;
	normalizedStrictSearchText: string;
	addressSearchText: string;
	primaryNameCandidates: string[];
	primaryNameTokens: string[];
	nameCandidates: string[];
	nameTokens: string[];
	surnameCandidates: string[];
	surnameCompactCandidates: string[];
};

export type LocalSearchIndex = {
	generatedAt?: string;
	bucket: string;
	docs: PreparedLocalSearchDoc[];
};

export type LocalSearchOptions = {
	limit?: number;
	offset?: number;
};

export type LocalSearchResponse = {
	bucket: LocalSearchBucket;
	generatedAt: string | null;
	total: number;
	hits: {
		total: number;
		start: number;
		hits: { _id: string; _source: LocalSearchHit }[];
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

function simplifyName(name: string): string {
	if (!name) return '';
	const punctuation = ['.', ',', '(', ')', '|', '[', ']', '{', '}'];
	const substitutions: Record<string, string> = { '-': ' ', 'ł': 'l', 'ø': 'o', 'æ': 'ae' };
	const suffixes = ['Esq', 'JD', 'MBA', 'PA', 'PhD', 'Jr', 'Sr', 'II', 'III', 'IV', 'V'].map((s) => ` ${s.toLowerCase()}`);

	// Lowercase and remove diacritics
	let simple = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '');

	// Remove punctuation
	for (const p of punctuation) {
		if (simple.includes(p)) {
			simple = simple.split(p).join('');
		}
	}

	// Substitutions
	for (const [k, v] of Object.entries(substitutions)) {
		if (simple.includes(k)) {
			simple = simple.split(k).join(v);
		}
	}

	// Remove suffixes
	for (const s of suffixes) {
		if (simple.endsWith(s)) {
			simple = simple.slice(0, -s.length);
		}
	}

	return simple.replace(/\s+/g, ' ').trim();
}

const NICKNAMES_RAW: Record<string, string[]> = {
	william: ['bill', 'billy', 'will', 'willy'],
	robert: ['bob', 'bobby', 'rob', 'bert'],
	richard: ['dick', 'rick', 'rich'],
	theodore: ['theo', 'ted', 'teddy'],
	samantha: ['sam', 'sammy'],
	kathryn: ['katie', 'katy', 'kate', 'kathleen', 'katherine', 'catherine', 'cathy'],
	matthew: ['matt'],
	nicholas: ['nick'],
	alexander: ['alex', 'sasha', 'al'],
	alexandra: ['alex', 'lexi', 'ali'],
	elizabeth: ['beth', 'liz', 'lizzie', 'eliza'],
	james: ['jim', 'jimmy', 'jamie'],
	john: ['jack', 'johnny'],
	joseph: ['joe', 'joey'],
	charles: ['charlie', 'chuck'],
	christopher: ['chris'],
	david: ['dave'],
	thomas: ['tom', 'tommy'],
	steven: ['steve'],
	patrick: ['pat'],
	gerald: ['jerry'],
	lawrence: ['larry'],
	ronald: ['ron', 'ronny'],
	anthony: ['tony'],
	timothy: ['tim', 'timmy'],
	michael: ['mike', 'micky'],
};

const NICKNAME_MAP = new Map<string, string[]>();
Object.entries(NICKNAMES_RAW).forEach(([formal, variants]) => {
	const all = Array.from(new Set([formal, ...variants]));
	all.forEach((name) => {
		NICKNAME_MAP.set(name, all);
	});
});

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

	const rawNames = [primaryIndividualName, primaryFirmName, hit.name, hit.fullName, hit.full_name, hit.displayName, hit.label, hit.personName];

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

	extraNameKeys.forEach((key) => {
		rawNames.push(...arrayify(hit[key]));
	});

	const candidates = new Set<string>();
	rawNames.forEach((n) => {
		const simple = simplifyName(String(n || ''));
		if (simple) {
			candidates.add(simple);
			if (simple.includes(' ')) {
				candidates.add(simple.replace(/\s+/g, ''));
			}
			const parts = simple.split(' ');
			if (parts.some((p) => p.length === 1)) {
				const noInitials = parts.filter((p) => p.length > 1).join(' ');
				if (noInitials) candidates.add(noInitials);
			}
		}
	});

	return Array.from(candidates);
}

function collectSurnameCandidates(doc: LocalSearchDoc) {
	const hit = doc.hit || {};
	const rawSurnames = [hit.ind_lastname, hit.lastName, hit.lastname, hit.surname, hit.familyName];
	const candidates = new Set<string>();
	rawSurnames.forEach((s) => {
		const simple = simplifyName(String(s || ''));
		if (simple) candidates.add(simple);
	});
	return Array.from(candidates);
}

function prepareDoc(doc: LocalSearchDoc): PreparedLocalSearchDoc {
	const hit = doc.hit || {};
	const primaryIndividualName = [hit.ind_firstname, hit.ind_middlename, hit.ind_lastname].filter(Boolean).join(' ');
	const primaryFirmName = hit.firm_name || hit.firmName || hit.organizationName || hit.organization_name || hit.companyName || hit.legalName || hit.name;
	const primaryNameCandidates = uniqueNormalized([primaryIndividualName, primaryFirmName, hit.name, hit.fullName, hit.full_name, hit.displayName, hit.label, hit.personName]);
	const nameCandidates = collectNameCandidates(doc);
	const surnameCandidates = collectSurnameCandidates(doc);
	const normalizedNameSearchText = simplifyName(doc.nameSearchText || primaryNameCandidates.join(' '));
	const normalizedStrictSearchText = simplifyName(doc.strictSearchText || doc.searchText);
	const primaryNameTokens = Array.from(new Set(primaryNameCandidates.flatMap((candidate) => tokenizeQuery(candidate))));
	const nameTokens = Array.from(new Set(nameCandidates.flatMap((candidate) => tokenizeQuery(candidate))));
	return {
		...doc,
		primaryNameSearchText: normalizedNameSearchText,
		normalizedNameSearchText,
		normalizedStrictSearchText,
		addressSearchText: normalizeText((doc as any).addressSearchText || ''),
		primaryNameCandidates,
		primaryNameTokens,
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

const MIN_SEARCH_QUERY_CHARS = 3;
const SHORT_QUERY_ALLOWLIST = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);

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
					// Try local file first
					const filePath = getSearchIndexFilePath(bucket);
					const raw = await readFile(filePath, 'utf-8');
					const parsed = JSON.parse(raw) as { generatedAt?: string; bucket?: string; docs?: LocalSearchDoc[] };
					return {
						generatedAt: parsed?.generatedAt,
						bucket: parsed?.bucket,
						docs: Array.isArray(parsed?.docs) ? parsed.docs.map(prepareDoc) : [],
					};
				} catch (err: any) {
					// Fall back to Redis if local file not found
					console.warn(`[localSearch] Local file not found for ${bucket}, trying Redis...`);
					const redisData = await fetchFromRedis(bucket);
					if (redisData) {
						return {
							generatedAt: redisData?.generatedAt,
							bucket: redisData?.bucket,
							docs: Array.isArray(redisData?.docs) ? redisData.docs.map(prepareDoc) : [],
						};
					}
					console.error(`[localSearch] Failed to load index for bucket ${bucket}:`, err.message);
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
	const strictText = doc.primaryNameSearchText || doc.normalizedNameSearchText;
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

	const nicknames = NICKNAME_MAP.get(queryToken);
	if (nicknames && nicknames.includes(candidateToken)) return true;

	// Candidate token contains the query token (e.g. 'hooten' contains 'hoot')
	if (candidateToken.includes(queryToken) && queryToken.length >= 3) return true;

	const minLength = Math.min(queryToken.length, candidateToken.length);
	if (minLength < 4) return false;
	const maxDistance = Math.max(1, Math.floor(queryToken.length * 0.3));
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
		else if (candidate.includes(compactQuery) && compactQuery.length >= 4) bestScore = Math.max(bestScore, strictSurnameQuery ? 200 : 140);
		else if (!strictSurnameQuery && compactQuery.length >= 4 && tokensFuzzyMatch(compactQuery, candidate)) bestScore = Math.max(bestScore, 120);
	}
	return bestScore;
}

function getNameMatchScore(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	if (isStrictSurnameQuery(rawQuery, normalizedQuery)) {
		return getSurnameMatchScore(doc, rawQuery, normalizedQuery);
	}
	let bestScore = 0;
	for (const candidate of doc.nameCandidates) {
		const isPrimaryCandidate = doc.primaryNameCandidates.includes(candidate);
		if (candidate === normalizedQuery) bestScore = Math.max(bestScore, isPrimaryCandidate ? 260 : 220);
		else if (containsWholePhrase(candidate, normalizedQuery)) bestScore = Math.max(bestScore, isPrimaryCandidate ? 180 : 150);
		else if (candidate.includes(normalizedQuery) && normalizedQuery.length >= 3) bestScore = Math.max(bestScore, isPrimaryCandidate ? 130 : 110);

		const candidateTokens = tokenizeQuery(candidate);
		const matchedTokenCount = tokens.filter((token) => candidateTokens.some((candidateToken) => tokensFuzzyMatch(token, candidateToken))).length;
		if (matchedTokenCount === tokens.length && tokens.length > 0) {
			bestScore = Math.max(bestScore, (isPrimaryCandidate ? 150 : 130) + matchedTokenCount * 20);
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
	const addressText = doc.addressSearchText;
	const identifier = getIdentifierText(doc);
	let score = 0;
	if (identifier === normalizedQuery) score += 300;
	if (doc.id.toLowerCase().endsWith(`:${normalizedQuery}`)) score += 250;
	if (containsWholePhrase(strictText, normalizedQuery)) score += 100;
	if (containsWholePhrase(nameText, normalizedQuery)) score += 40;
	if (containsWholePhrase(addressText, normalizedQuery)) score += 80; // High boost for geographic phrase match
	if (nameText.includes(normalizedQuery)) score += 20;
	if (addressText.includes(normalizedQuery)) score += 30; // Boost for geographic substring match

	score += getNameMatchScore(doc, rawQuery, normalizedQuery, tokens);
	for (const token of tokens) {
		if (identifier === token) score += 120;
		if (containsWholePhrase(strictText, token)) score += 20;
		if (containsWholePhrase(addressText, token)) score += 40;
	}
	return score;
}

function matchesQuery(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	if (!tokens.length) return false;

	const identifier = getIdentifierText(doc);
	if (identifier === normalizedQuery) return true;

	if (isStrictSurnameQuery(rawQuery, normalizedQuery)) {
		return getSurnameMatchScore(doc, rawQuery, normalizedQuery) > 0;
	}

	// Must match ALL tokens in the query
	const allTokensMatch = tokens.every((token) => {
		// Exact word or substring match in any candidate full name (candidate must contain token)
		if (doc.nameCandidates.some((candidate) => candidate.includes(token))) {
			return true;
		}
		// Match in current address
		if (doc.addressSearchText.includes(token)) {
			return true;
		}
		// Fuzzy token match (includes nicknames)
		if (doc.nameTokens.some((nameToken) => tokensFuzzyMatch(token, nameToken))) {
			return true;
		}
		return false;
	});

	if (allTokensMatch) return true;

	if (getNameMatchScore(doc, rawQuery, normalizedQuery, tokens) > 0) return true;
	if (hasStrictMatch(doc, normalizedQuery, tokens)) return true;
	return false;
}

export async function searchLocalIndex(source: LocalSearchSource, type: LocalSearchEntity, query: string, options: LocalSearchOptions = {}): Promise<LocalSearchResponse> {
	const bucket = `${source}:${type}` as LocalSearchBucket;
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const normalizedQuery = simplifyName(query);
	const tokens = tokenizeQuery(query);
	const index = await loadIndex(bucket);

	// If index failed to load, return null result to trigger fallback search
	if (!index) {
		return {
			bucket,
			generatedAt: null,
			total: 0,
			hits: { total: 0, start: offset, hits: [] },
			response: { numFound: 0, start: offset, docs: [] },
			results: [],
			currentPage: [],
			pageNumber: Math.floor(offset / Math.max(limit, 1)) + 1,
			pageSize: limit,
		};
	}

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
