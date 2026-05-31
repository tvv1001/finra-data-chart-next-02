import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './constants';

type SearchType = 'individual' | 'firm';
type SearchSource = 'finra' | 'sec';

type LocalSearchDoc = {
	id: string;
	type: SearchType;
	source: SearchSource;
	searchText: string;
	hit: Record<string, unknown>;
};

type PreparedLocalSearchDoc = LocalSearchDoc & {
	compactSearchText: string;
	searchTokens: string[];
	compactTokens: string[];
};

type SearchResponse = {
	hits: {
		total: number;
		hits: Array<{ _source: Record<string, unknown> }>;
	};
};

const NATIONAL_DIR = path.join(DATA_DIR, 'national');

type BucketCacheEntry = {
	mtimeMs: number;
	docs: PreparedLocalSearchDoc[];
};

const bucketCache = new Map<string, BucketCacheEntry>();

function getBucketKey(source: SearchSource, type: SearchType) {
	return `${source}:${type}`;
}

function getSearchIndexPath(source: SearchSource, type: SearchType) {
	return path.join(NATIONAL_DIR, `search-index.${source}.${type}.json`);
}

function normalizeText(value: unknown) {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function buildSearchText(parts: unknown[]) {
	return normalizeText(parts.filter(Boolean).join(' '));
}

function collectOtherNames(payload: any, basic: Record<string, unknown> = {}) {
	const values = [
		...(Array.isArray(payload?.otherNames) ? payload.otherNames : []),
		...(Array.isArray(payload?.other_names) ? payload.other_names : []),
		...(Array.isArray((basic as any)?.otherNames) ? (basic as any).otherNames : []),
		...(Array.isArray((basic as any)?.other_names) ? (basic as any).other_names : []),
	];
	return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function compactText(value: string) {
	return value.replace(/\s+/g, '');
}

function tokenizeSearchText(value: string) {
	return Array.from(new Set(value.split(/\s+/).filter(Boolean)));
}

function prepareDoc(doc: LocalSearchDoc): PreparedLocalSearchDoc {
	const searchText = normalizeText(doc.searchText);
	const searchTokens = tokenizeSearchText(searchText);
	return {
		...doc,
		searchText,
		compactSearchText: compactText(searchText),
		searchTokens,
		compactTokens: searchTokens.map((token) => compactText(token)),
	};
}

function levenshteinDistance(left: string, right: string) {
	if (left === right) return 0;
	if (!left.length) return right.length;
	if (!right.length) return left.length;

	const prev = new Array(right.length + 1);
	const curr = new Array(right.length + 1);
	for (let j = 0; j <= right.length; j += 1) prev[j] = j;

	for (let i = 1; i <= left.length; i += 1) {
		curr[0] = i;
		for (let j = 1; j <= right.length; j += 1) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j];
	}

	return prev[right.length];
}

function scoreTokenAgainstDoc(token: string, doc: PreparedLocalSearchDoc) {
	if (!token) return 0;
	if (doc.searchText.includes(token) || doc.compactSearchText.includes(token)) return 1;

	if (token.length >= 6) {
		for (const docToken of doc.compactTokens) {
			if (!docToken || docToken.length < 3) continue;
			if (token.startsWith(docToken) || token.endsWith(docToken)) {
				return Math.max(0.6, docToken.length / token.length);
			}
		}
	}

	let bestScore = 0;
	for (const docToken of doc.compactTokens) {
		if (!docToken || docToken.length < 3) continue;
		const lengthDiff = Math.abs(docToken.length - token.length);
		if (lengthDiff > 2) continue;
		const distance = levenshteinDistance(token, docToken);
		const maxLen = Math.max(token.length, docToken.length);
		const allowedDistance =
			maxLen <= 4 ? 1
			: maxLen <= 8 ? 2
			: 3;
		if (distance > allowedDistance) continue;
		bestScore = Math.max(bestScore, 1 - distance / maxLen);
	}

	return bestScore;
}

function scoreDocAgainstTokens(tokens: string[], doc: PreparedLocalSearchDoc) {
	let totalScore = 0;
	for (const token of tokens) {
		const score = scoreTokenAgainstDoc(token, doc);
		if (score <= 0) return 0;
		totalScore += score;
	}
	return totalScore;
}

function scorePreparedDocForQuery(query: string, doc: PreparedLocalSearchDoc) {
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return 0;
	const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
	if (!tokens.length) return 0;
	return filterExactMatches(tokens, [doc]).length ? tokens.length : scoreDocAgainstTokens(tokens, doc);
}

export function scoreSearchValues(query: string, values: unknown[]) {
	const searchText = buildSearchText(values);
	if (!searchText) return 0;
	const prepared = prepareDoc({
		id: '__query__',
		type: 'firm',
		source: 'finra',
		searchText,
		hit: {},
	});
	return scorePreparedDocForQuery(query, prepared);
}

export function matchesSearchValues(query: string, values: unknown[]) {
	return scoreSearchValues(query, values) > 0;
}

function filterExactMatches(tokens: string[], docs: PreparedLocalSearchDoc[]) {
	return docs.filter((doc) => tokens.every((token) => doc.searchText.includes(token) || doc.compactSearchText.includes(token)));
}

function filterFuzzyMatches(tokens: string[], docs: PreparedLocalSearchDoc[]) {
	return docs
		.map((doc) => ({ doc, score: scoreDocAgainstTokens(tokens, doc) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.doc.id.localeCompare(right.doc.id))
		.map((entry) => entry.doc);
}

function sanitizeBranchOffice(office: any) {
	if (!office || typeof office !== 'object') return null;
	return {
		city: office.city || null,
		state: office.state || null,
		street1: office.street1 || null,
		street2: office.street2 || null,
		zipCode: office.zipCode || null,
	};
}

function sanitizeEmployment(employment: any) {
	if (!employment || typeof employment !== 'object') return employment;
	const branchOffice = sanitizeBranchOffice(employment.branchOfficeLocations?.[0]);
	return {
		firmId: employment.firmId ?? employment.firm_id ?? null,
		firm_id: employment.firm_id ?? employment.firmId ?? null,
		firmName: employment.firmName || employment.firm_name || employment.organizationName || employment.legalName || null,
		firm_name: employment.firm_name || employment.firmName || employment.organizationName || employment.legalName || null,
		iaOnly: employment.iaOnly ?? null,
		registrationBeginDate: employment.registrationBeginDate || employment.startDate || employment.fromDate || null,
		registrationEndDate: employment.registrationEndDate || employment.endDate || employment.toDate || null,
		employmentStatus: employment.employmentStatus || employment.status || employment.currentStatus || null,
		firmBCScope: employment.firmBCScope || null,
		firmIAScope: employment.firmIAScope || null,
		bdSECNumber: employment.bdSECNumber ?? employment.firm_bd_sec_number ?? null,
		iaSECNumber: employment.iaSECNumber ?? employment.firm_ia_sec_number ?? null,
		city: employment.city || branchOffice?.city || null,
		state: employment.state || branchOffice?.state || null,
		zipCode: employment.zipCode || branchOffice?.zipCode || null,
		expelledDate: employment.expelledDate || null,
		branchOfficeLocations: branchOffice ? [branchOffice] : [],
	};
}

function extractFileMeta(fileName: string) {
	const match = fileName.match(/^api\.(brokercheck\.finra\.org|adviserinfo\.sec\.gov)_search_(individual|firm)_(.+)\.json$/i);
	if (!match) return null;
	const [, host, type, id] = match;
	return {
		source: host === 'brokercheck.finra.org' ? 'finra' : 'sec',
		type: type.toLowerCase() as SearchType,
		id: String(id).trim(),
	};
}

function buildIndividualDoc(meta: ReturnType<typeof extractFileMeta>, payload: any): LocalSearchDoc | null {
	const basic = payload?.basicInformation || {};
	const id = String(basic?.individualId || basic?.crd || meta?.id || '').trim();
	if (!id) return null;

	const firstName = basic?.firstName || payload?.firstName || '';
	const middleName = basic?.middleName || payload?.middleName || '';
	const lastName = basic?.lastName || payload?.lastName || '';
	const otherNames = collectOtherNames(payload, basic);
	const currentEmployments = Array.isArray(payload?.currentEmployments) ? payload.currentEmployments.map((employment: any) => sanitizeEmployment(employment)) : [];
	const currentIAEmployments = Array.isArray(payload?.currentIAEmployments) ? payload.currentIAEmployments.map((employment: any) => sanitizeEmployment(employment)) : [];
	const previousEmployments = Array.isArray(payload?.previousEmployments) ? payload.previousEmployments : [];
	const previousIAEmployments = Array.isArray(payload?.previousIAEmployments) ? payload.previousIAEmployments : [];
	const employmentNames = [...currentEmployments, ...currentIAEmployments, ...previousEmployments, ...previousIAEmployments].map(
		(employment: any) => employment?.firmName || employment?.firm_name || employment?.organizationName || '',
	);
	const searchText = buildSearchText([id, firstName, middleName, lastName, ...otherNames, basic?.bcScope, basic?.iaScope, ...employmentNames]);

	return {
		id: `${meta?.source}:${meta?.type}:${id}`,
		type: 'individual',
		source: meta?.source as SearchSource,
		searchText,
		hit: {
			ind_source_id: id,
			ind_crd: id,
			ind_firstname: firstName,
			ind_middlename: middleName,
			ind_lastname: lastName,
			ind_other_names: otherNames,
			otherNames,
			ind_bc_scope: basic?.bcScope ?? payload?.bcScope ?? null,
			ind_ia_scope: basic?.iaScope ?? payload?.iaScope ?? null,
			ind_approved_finra_registration_count: payload?.registrationCount?.approvedFinraRegistrationCount ?? 0,
			ind_approved_sro_registration_count: payload?.registrationCount?.approvedSRORegistrationCount ?? 0,
			ind_approved_state_registration_count: payload?.registrationCount?.approvedStateRegistrationCount ?? 0,
			ind_approved_ia_state_registration_count: payload?.registrationCount?.approvedIAStateRegistrationCount ?? 0,
			ind_current_employments: currentEmployments,
			ind_ia_current_employments: currentIAEmployments,
			disclosureFlag: payload?.disclosureFlag ?? basic?.disclosureFlag ?? null,
			iaDisclosureFlag: payload?.iaDisclosureFlag ?? basic?.iaDisclosureFlag ?? null,
		},
	};
}

function buildFirmDoc(meta: ReturnType<typeof extractFileMeta>, payload: any): LocalSearchDoc | null {
	const basic = payload?.basicInformation || {};
	const id = String(basic?.firmId || payload?.firmId || meta?.id || '').trim();
	if (!id) return null;

	const firmName = String(basic?.firmName || payload?.firmName || payload?.name || '').trim();
	const otherNames = collectOtherNames(payload, basic);
	const searchText = buildSearchText([
		id,
		firmName,
		...otherNames,
		basic?.bdSECNumber,
		basic?.bdSecNumber,
		basic?.iaSECNumber,
		basic?.iaSecNumber,
		basic?.bcScope,
		basic?.firmStatus,
	]);

	return {
		id: `${meta?.source}:${meta?.type}:${id}`,
		type: 'firm',
		source: meta?.source as SearchSource,
		searchText,
		hit: {
			firm_id: id,
			firmId: id,
			firm_source_id: id,
			firm_name: firmName || `Firm ${id}`,
			firmName: firmName || `Firm ${id}`,
			firm_other_names: otherNames,
			otherNames,
			firm_bc_scope: basic?.bcScope ?? payload?.bcScope ?? null,
			bdSecNumber: basic?.bdSECNumber ?? basic?.bdSecNumber ?? payload?.bdSECNumber ?? payload?.bdSecNumber ?? null,
			iaSecNumber: basic?.iaSECNumber ?? basic?.iaSecNumber ?? payload?.iaSECNumber ?? payload?.iaSecNumber ?? null,
			disclosureFlag: payload?.disclosureFlag ?? basic?.disclosureFlag ?? null,
			iaDisclosureFlag: payload?.iaDisclosureFlag ?? basic?.iaDisclosureFlag ?? null,
		},
	};
}

function parseSearchIndexDocs(json: any): PreparedLocalSearchDoc[] {
	const docs =
		Array.isArray(json) ? (json as LocalSearchDoc[])
		: Array.isArray(json?.docs) ? (json.docs as LocalSearchDoc[])
		: [];
	return docs.map((doc) => prepareDoc(doc));
}

async function readBucketIndex(source: SearchSource, type: SearchType) {
	const bucketKey = getBucketKey(source, type);
	const searchIndexPath = getSearchIndexPath(source, type);
	try {
		const indexStat = await stat(searchIndexPath);
		const cached = bucketCache.get(bucketKey);
		if (cached && cached.mtimeMs === indexStat.mtimeMs) return cached.docs;
		const raw = await readFile(searchIndexPath, 'utf8');
		const docs = parseSearchIndexDocs(JSON.parse(raw));
		bucketCache.set(bucketKey, { mtimeMs: indexStat.mtimeMs, docs });
		return docs;
	} catch {
		return null;
	}
}

async function buildBucketFromCanonicalFiles(source: SearchSource, type: SearchType) {
	const entries = await readdir(NATIONAL_DIR, { withFileTypes: true });
	const docs: PreparedLocalSearchDoc[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const meta = extractFileMeta(entry.name);
		if (!meta) continue;
		if (meta.source !== source || meta.type !== type) continue;
		try {
			const raw = await readFile(path.join(NATIONAL_DIR, entry.name), 'utf8');
			const json = JSON.parse(raw);
			const payload = json?.content || json?.iacontent || json;
			const doc = meta.type === 'individual' ? buildIndividualDoc(meta, payload) : buildFirmDoc(meta, payload);
			if (doc) docs.push(prepareDoc(doc));
		} catch {
			// ignore malformed local cache files
		}
	}
	return docs;
}

async function getDocs(source: SearchSource, type: SearchType) {
	const bucketKey = getBucketKey(source, type);
	const indexedDocs = await readBucketIndex(source, type);
	if (indexedDocs) return indexedDocs;
	const docs = await buildBucketFromCanonicalFiles(source, type);
	bucketCache.set(bucketKey, { mtimeMs: Date.now(), docs });
	return docs;
}

export async function searchLocalCache(options: { query: string; type: SearchType; source: SearchSource; start?: number; limit?: number }): Promise<SearchResponse> {
	const query = normalizeText(options.query);
	if (!query) return { hits: { total: 0, hits: [] } };
	const start = Math.max(0, options.start || 0);
	const limit = Math.max(1, Math.min(options.limit || 12, 1000));
	const tokens = query.split(/\s+/).filter(Boolean);
	const docs = await getDocs(options.source, options.type);
	const exactMatched = filterExactMatches(tokens, docs);
	const matched = exactMatched.length ? exactMatched : filterFuzzyMatches(tokens, docs);
	const hits = matched.slice(start, start + limit).map((doc) => ({ _source: doc.hit }));
	return {
		hits: {
			total: matched.length,
			hits,
		},
	};
}

export const __localSearchInternals = {
	normalizeText,
	compactText,
	tokenizeSearchText,
	prepareDoc,
	levenshteinDistance,
	scoreTokenAgainstDoc,
	scoreDocAgainstTokens,
	scorePreparedDocForQuery,
	filterExactMatches,
	filterFuzzyMatches,
	collectOtherNames,
};
