import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Redis } from '@upstash/redis';
import { cachedFetch } from '@/lib/simpleCache';
import { normalizeIndividualDetailPayload } from '@/lib/individualDetail';
import { setStringIfValid } from '@/lib/redisCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_EXTERNAL_RAW_DIR = '/home/lenny/Dev/webDev/Data-finra-sec/data/raw';
const PRIMED_REDIS_CHUNK_CHARS = Number(process.env.PRIMED_REDIS_CHUNK_CHARS || 700_000);
const DASHBOARD_REDIS_SCAN_CARD_LIMIT_PER_PATTERN = Number(process.env.DASHBOARD_REDIS_SCAN_CARD_LIMIT_PER_PATTERN || 5_000);
const DASHBOARD_RECENCY_MTIME_SAMPLE_LIMIT = Number(process.env.DASHBOARD_RECENCY_MTIME_SAMPLE_LIMIT || 2_000);
const DASHBOARD_REDIS_MIN_CARD_COUNT = Math.max(1_000, Number(process.env.DASHBOARD_REDIS_MIN_CARD_COUNT || 1_000) || 1_000);
const BUILD_MANIFEST_PATH = path.join(process.cwd(), 'data', 'build_manifest.json');

let manifestTotalsCache: { totalCards: number; totalCacheKeys: number } | null = null;
let primedBundleTotalsCache: { totalCards: number; totalCacheKeys: number } | null = null;
let manifestCardIndexCache: Map<string, CacheCard> | null = null;
let primedBundleCardIndexCache: Map<string, CacheCard> | null = null;

type DashboardAction = 'fetch-crds' | 'sync-and-deploy-primed' | 'list-cache-cards' | 'list-new-crds';

type RefreshRequestBody = {
	action?: DashboardAction;
	crds?: string[] | string;
	queries?: string[] | string;
	externalRawDir?: string;
	maxCrds?: number;
	includePayload?: boolean;
	maxCards?: number;
	crdFilter?: string;
};

type FetchResultItem = {
	crd: string;
	source: 'finra' | 'sec';
	type: 'individual' | 'firm';
	url: string;
	cacheFile: string;
	redisKey: string;
	status: 'ok' | 'error';
	redisWrite: string;
	error?: string;
	payload?: unknown;
};

type FetchTarget = {
	crd: string;
	source: 'finra' | 'sec';
	type: 'individual' | 'firm';
};

type CacheCardSource = {
	source: 'finra' | 'sec';
	status: 'ok' | 'unknown';
};

type CacheCard = {
	id: string;
	entity: 'individual' | 'firm';
	files: number;
	sources: CacheCardSource[];
	name?: string;
	statusText?: string;
	memberSince?: string;
};

type CacheCardWithMeta = CacheCard & {
	updatedAt: number;
};

type InventoryTotals = {
	people: number;
	firms: number;
	unique: number;
	source: 'external-raw' | 'local-raw';
};

function hasAnyItems(list: unknown) {
	return Array.isArray(list) && list.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, any> {
	return isPlainObject(value);
}

function normalizeScopeValue(value: unknown) {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
}

function isNotInScopeValue(value: unknown) {
	return normalizeScopeValue(value) === 'notinscope';
}

function collectNodeActivityFlags(values: unknown[]) {
	let hasActive = false;
	let hasInactive = false;
	for (const value of values) {
		const normalized = normalizeScopeValue(value);
		if (!normalized || normalized === 'notinscope') continue;
		if (/inactive|terminated|revoked|suspended|withdrawn|barred|expelled|denied|ceased|closed|previouslyregistered|nolongerregistered|notregistered/.test(normalized)) {
			hasInactive = true;
			continue;
		}
		if (/active|approved|current|registered/.test(normalized)) {
			hasActive = true;
			continue;
		}
		hasInactive = true;
	}
	return { hasActive, hasInactive };
}

function hasApprovedSro(list: unknown) {
	return Array.isArray(list) && list.some((entry) => /approved|active|current|registered/i.test(String(entry?.registrationStatus || entry?.status || entry?.scope || '')));
}

function hasActiveRegisteredStates(list: unknown, allowedScopes: string[]) {
	if (!Array.isArray(list)) return false;
	const allowed = new Set(
		allowedScopes.map((scope) =>
			String(scope || '')
				.trim()
				.toLowerCase(),
		),
	);
	return list.some((entry) => {
		const scope = String(entry?.regScope || entry?.scope || '')
			.trim()
			.toLowerCase();
		if (!scope || !allowed.has(scope)) return false;
		const status = normalizeScopeValue(entry?.registrationStatus || entry?.status || entry?.regStatus || 'active');
		return !status || (!/inactive|terminated|revoked|suspended|withdrawn|notregistered|notinscope/.test(status) && /active|approved|current|registered/.test(status));
	});
}

function hasPublicFinraIndividualPage(detail: any, basicInformation: Record<string, any> = {}) {
	const bcScope = normalizeScopeValue(detail?.bcScope || basicInformation?.bcScope || '');
	if (bcScope === 'notinscope') return false;
	if (bcScope) return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedFinraRegistrationCount || 0) > 0) return true;
	if (Number(registrationCount.approvedSRORegistrationCount || 0) > 0) return true;
	if (hasAnyItems(detail?.registeredSROs)) return true;

	return false;
}

function hasPublicSecIndividualPage(detail: any, basicInformation: Record<string, any> = {}) {
	const iaScope = normalizeScopeValue(detail?.iaScope || basicInformation?.iaScope || '');
	if (iaScope && iaScope !== 'notinscope') return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (hasAnyItems(detail?.currentIAEmployments)) return true;
	if (hasAnyItems(detail?.iaDisclosures)) return true;
	if (
		Array.isArray(detail?.registeredStates) &&
		detail.registeredStates.some(
			(entry: any) =>
				String(entry?.regScope || '')
					.trim()
					.toLowerCase() === 'ia',
		)
	)
		return true;

	return false;
}

function hasIndividualFinraPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	if (node.hasFinraData === true) return true;
	if (hasPublicFinraIndividualPage(node, node.basicInformation || {})) return true;
	if (hasAnyItems(node?.currentEmployments)) return true;
	if (hasAnyItems(node?.previousEmployments)) return true;
	if (hasApprovedSro(node?.registeredSROs)) return true;
	if (hasActiveRegisteredStates(node?.registeredStates, ['bc', 'b', 'broker'])) return true;
	const bcScopeFlags = collectNodeActivityFlags([node?.bcScope, node?.basicInformation?.bcScope]);
	return bcScopeFlags.hasActive || bcScopeFlags.hasInactive;
}

function hasIndividualSecPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	if (node.hasSecData === true) return true;
	if (hasPublicSecIndividualPage(node, node.basicInformation || {})) return true;
	if (Number(node?.registrationCount?.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (hasAnyItems(node?.currentIAEmployments)) return true;
	if (hasAnyItems(node?.previousIAEmployments)) return true;
	if (hasAnyItems(node?.iaDisclosures)) return true;
	if (hasActiveRegisteredStates(node?.registeredStates, ['ia'])) return true;
	const iaScopeFlags = collectNodeActivityFlags([node?.iaScope, node?.basicInformation?.iaScope]);
	return iaScopeFlags.hasActive || iaScopeFlags.hasInactive;
}

function parseIndividualDetailPayload(data: unknown, contentKey: 'content' | 'iacontent', fallbackCrd = '') {
	if (!data) return null;

	const normalizeCandidate = (candidate: unknown) => {
		if (!isPlainObject(candidate)) return null;
		return normalizeIndividualDetailPayload(candidate, fallbackCrd);
	};

	if (isPlainObject(data) && Array.isArray(data?.hits?.hits) && data.hits.hits.length > 0) {
		const source = data.hits.hits[0]?._source || {};
		const raw = source?.[contentKey];
		try {
			return normalizeCandidate({
				...source,
				...(typeof raw === 'string' ? JSON.parse(raw) : raw || {}),
			});
		} catch {
			return normalizeCandidate(source);
		}
	}

	if (isPlainObject(data)) {
		const raw = data?.[contentKey];
		if (raw != null) {
			try {
				return normalizeCandidate({
					...data,
					...(typeof raw === 'string' ? JSON.parse(raw) : raw || {}),
				});
			} catch {
				return normalizeCandidate(data);
			}
		}

		const looksLikeDetail =
			data.basicInformation ||
			data.individualId ||
			data.firstName ||
			data.lastName ||
			data.bcScope ||
			data.iaScope ||
			data.disclosures ||
			data.currentEmployments ||
			data.previousEmployments ||
			data.currentIAEmployments ||
			data.previousIAEmployments;
		if (looksLikeDetail) return normalizeCandidate(data);
	}

	return null;
}

async function loadCachedIndividualPayload(source: 'finra' | 'sec', id: string) {
	const key = `${source}:individual:${id}`;
	const payload = await cachedFetch<any>(key, 60 * 60 * 24, async () => undefined as unknown as any);
	return parseIndividualDetailPayload(payload, source === 'finra' ? 'content' : 'iacontent', id);
}

async function normalizeCardSourcesForDisplay(card: CacheCard): Promise<CacheCard> {
	if (card.entity !== 'individual' || card.sources.length <= 1) return card;

	const normalizedSources: CacheCardSource[] = [];
	let evaluatedSourceCount = 0;

	for (const sourceEntry of card.sources) {
		const detail = await loadCachedIndividualPayload(sourceEntry.source, card.id);
		if (!detail) continue;
		evaluatedSourceCount += 1;

		const includeSource = sourceEntry.source === 'finra' ? hasIndividualFinraPresence(detail) : hasIndividualSecPresence(detail);
		if (includeSource) normalizedSources.push(sourceEntry);
	}

	if (evaluatedSourceCount === 0 || normalizedSources.length === 0) return card;
	return {
		...card,
		files: normalizedSources.length,
		sources: normalizedSources,
	};
}

function upsertCardIndexEntry(index: Map<string, CacheCard>, hit: { source: 'finra' | 'sec'; entity: 'individual' | 'firm'; id: string }) {
	const key = `${hit.entity}:${hit.id}`;
	const existing = index.get(key) || {
		id: hit.id,
		entity: hit.entity,
		files: 0,
		sources: [],
	};
	existing.files += 1;
	if (!existing.sources.some((entry) => entry.source === hit.source)) {
		existing.sources.push({ source: hit.source, status: 'ok' });
	}
	index.set(key, existing);
}

function classifyStatusText(value: unknown) {
	const normalized = String(value || '')
		.trim()
		.toLowerCase();
	if (!normalized) return 'Unknown';
	if (/inactive|terminated|revoked|suspended|withdrawn|denied|ceased|notinscope|not\s*active|previously\s*registered/.test(normalized)) return 'Inactive';
	if (/active|approved|current|registered|effective/.test(normalized)) return 'Active';
	return 'Unknown';
}

function findFirstDate(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (/\d{4}-\d{2}-\d{2}/.test(trimmed) || /^\d{4}$/.test(trimmed) || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(trimmed)) {
			return trimmed;
		}
		return null;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = findFirstDate(entry);
			if (found) return found;
		}
		return null;
	}
	if (isPlainObject(value)) {
		for (const key of [
			'memberSince',
			'member_since',
			'registeredSince',
			'registered_since',
			'registrationDate',
			'registration_date',
			'dateRegistered',
			'date_registered',
			'startDate',
			'start_date',
			'start',
			'effectiveDate',
			'effective_date',
			'since',
		]) {
			if (key in value) {
				const found = findFirstDate(value[key]);
				if (found) return found;
			}
		}
	}
	return null;
}

export function extractCardSummaryFields(detail: Record<string, any>, fallbackCrd = '') {
	const basic = (detail?.basicInformation || {}) as Record<string, any>;
	const candidateName =
		String(basic.name || '').trim() ||
		[basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ').trim() ||
		String(detail?.legalName || '').trim() ||
		String(detail?.firmName || '').trim() ||
		String(detail?.name || '').trim() ||
		'';

	const memberSince = findFirstDate(detail) || findFirstDate(basic) || null;
	const finraStatus = classifyStatusText(detail?.bcScope || basic?.bcScope || detail?.registrationStatus || detail?.status);
	const secStatus = classifyStatusText(detail?.iaScope || basic?.iaScope || detail?.registrationStatus || detail?.status);

	return {
		name: candidateName || (fallbackCrd ? `Record ${fallbackCrd}` : ''),
		statusText: [finraStatus ? 'FINRA ' + finraStatus : null, secStatus ? 'SEC ' + secStatus : null].filter(Boolean).join(' • ') || null,
		memberSince,
	};
}

async function buildCardSummary(card: CacheCard) {
	const summary: Pick<CacheCard, 'name' | 'statusText' | 'memberSince'> = {};

	for (const sourceEntry of card.sources) {
		const detail = await loadCachedIndividualPayload(sourceEntry.source, card.id);
		if (!detail) continue;

		const normalized = normalizeIndividualDetailPayload(detail, card.id) as Record<string, any>;
		const extracted = extractCardSummaryFields(normalized, card.id);
		if (extracted.name && !summary.name) summary.name = extracted.name;
		if (extracted.memberSince && !summary.memberSince) summary.memberSince = extracted.memberSince;

		const statusParts = [
			sourceEntry.source === 'finra' ?
				`FINRA ${classifyStatusText(normalized.bcScope || normalized.basicInformation?.bcScope || normalized.registrationStatus || normalized.status)}`
			:	null,
			sourceEntry.source === 'sec' ?
				`SEC ${classifyStatusText(normalized.iaScope || normalized.basicInformation?.iaScope || normalized.registrationStatus || normalized.status)}`
			:	null,
		].filter(Boolean);
		if (!summary.statusText && statusParts.length) summary.statusText = statusParts.join(' • ');
		if (!summary.statusText && extracted.statusText) summary.statusText = extracted.statusText;
	}

	if (!summary.name && card.entity === 'individual') summary.name = `Individual ${card.id}`;
	if (!summary.name && card.entity === 'firm') summary.name = `Firm ${card.id}`;
	if (!summary.statusText) {
		const statusParts = card.sources.map((entry) => `${entry.source.toUpperCase()} ${entry.status === 'ok' ? 'Available' : 'Pending'}`);
		summary.statusText = statusParts.join(' • ');
	}

	return summary;
}

function normalizeCardForDisplay(card: CacheCard) {
	return {
		id: card.id,
		entity: card.entity,
		files: Math.max(1, card.sources.length),
		sources: [...card.sources].sort((a, b) => a.source.localeCompare(b.source)),
		name: card.name || null,
		statusText: card.statusText || null,
		memberSince: card.memberSince || null,
	};
}

function isValidFetchedPayload(payload: unknown): boolean {
	if (!isObject(payload)) return false;

	const hasHitArray = Array.isArray(payload?.hits?.hits);
	const hasDocsArray = Array.isArray(payload?.response?.docs) || Array.isArray(payload?.results) || Array.isArray(payload?.currentPage);
	const hasDetailMarkers =
		payload?.content != null ||
		payload?.iacontent != null ||
		payload?.basicInformation != null ||
		payload?.individualId != null ||
		payload?.firmId != null ||
		payload?.name != null ||
		payload?.firmName != null;
	const hasErrorOnly = typeof payload?.error === 'string' && !hasHitArray && !hasDocsArray && !hasDetailMarkers;

	if (hasErrorOnly) return false;
	return hasHitArray || hasDocsArray || hasDetailMarkers;
}

function parseCrds(input: RefreshRequestBody['crds'], maxCrds = 50): string[] {
	const tokens =
		typeof input === 'string' ?
			input
				.split(/[\s,]+/g)
				.map((value) => value.trim())
				.filter(Boolean)
		: Array.isArray(input) ? input.map((value) => String(value || '').trim()).filter(Boolean)
		: [];

	const unique = Array.from(new Set(tokens.filter((value) => /^\d{1,10}$/.test(value))));
	return unique.slice(0, Math.max(1, Math.min(500, maxCrds)));
}

function parseQueries(input: RefreshRequestBody['queries'] | RefreshRequestBody['crds'], maxQueries = 50): string[] {
	const tokens =
		typeof input === 'string' ?
			input
				.split(/[\n,;]+/g)
				.map((value) => value.trim())
				.filter(Boolean)
		: Array.isArray(input) ? input.map((value) => String(value || '').trim()).filter(Boolean)
		: [];

	const unique = Array.from(new Set(tokens));
	return unique.slice(0, Math.max(1, Math.min(200, maxQueries)));
}

function collectSearchItems(payload: any) {
	if (Array.isArray(payload?.results)) return payload.results;
	if (Array.isArray(payload?.currentPage)) return payload.currentPage;
	if (Array.isArray(payload?.hits?.hits)) return payload.hits.hits.map((hit: any) => hit?._source ?? hit);
	return [];
}

function extractNumericId(item: any, keys: string[]) {
	for (const key of keys) {
		const raw = item?.[key];
		if (raw == null) continue;
		const value = String(raw).trim();
		if (/^\d{1,10}$/.test(value)) return value;
	}
	return '';
}

async function resolveCrdsFromQueries(queries: string[], maxCrds = 50) {
	const resolved = new Set<string>();
	const targetMap = new Map<string, FetchTarget>();
	const resolution: Array<{ query: string; crdCount: number; crds: string[] }> = [];

	const addTarget = (target: FetchTarget) => {
		targetMap.set(`${target.source}:${target.type}:${target.crd}`, target);
	};

	const canIncludeCrd = (crd: string) => {
		if (resolved.has(crd)) return true;
		if (resolved.size >= maxCrds) return false;
		resolved.add(crd);
		return true;
	};

	for (const query of queries) {
		if (resolved.size >= maxCrds) break;
		if (/^\d{1,10}$/.test(query)) {
			if (canIncludeCrd(query)) {
				addTarget({ crd: query, source: 'finra', type: 'individual' });
				addTarget({ crd: query, source: 'sec', type: 'individual' });
				addTarget({ crd: query, source: 'finra', type: 'firm' });
				addTarget({ crd: query, source: 'sec', type: 'firm' });
			}
			resolution.push({ query, crdCount: 1, crds: [query] });
			continue;
		}

		try {
			const encoded = encodeURIComponent(query);
			const [finraIndividual, finraFirm, secIndividual, secFirm] = await Promise.all([
				fetchJson(`https://api.brokercheck.finra.org/search/individual?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
				fetchJson(`https://api.brokercheck.finra.org/search/firm?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
				fetchJson(`https://api.adviserinfo.sec.gov/search/individual?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
				fetchJson(`https://api.adviserinfo.sec.gov/search/firm?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
			]);

			const crdsForQuery = new Set<string>();
			const individualKeys = ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id'];
			const firmKeys = ['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];

			for (const item of collectSearchItems(finraIndividual)) {
				const id = extractNumericId(item, individualKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'finra', type: 'individual' });
			}
			for (const item of collectSearchItems(finraFirm)) {
				const id = extractNumericId(item, firmKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'finra', type: 'firm' });
			}
			for (const item of collectSearchItems(secIndividual)) {
				const id = extractNumericId(item, individualKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'sec', type: 'individual' });
			}
			for (const item of collectSearchItems(secFirm)) {
				const id = extractNumericId(item, firmKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'sec', type: 'firm' });
			}

			const crds = Array.from(crdsForQuery);
			resolution.push({ query, crdCount: crds.length, crds: crds.slice(0, 25) });
		} catch {
			resolution.push({ query, crdCount: 0, crds: [] });
		}
	}

	return {
		crds: Array.from(resolved).slice(0, maxCrds),
		targets: Array.from(targetMap.values()),
		resolution,
	};
}

function ensureRedisClient() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	return new Redis({ url, token });
}

async function exists(targetPath: string) {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function writeJsonFile(filePath: string, payload: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function fetchJson(url: string) {
	const response = await fetch(url, {
		headers: {
			'Accept': 'application/json',
			'User-Agent': 'finra-dashboard-refresh/1.0',
		},
		next: { revalidate: 0 },
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return response.json();
}

function splitIntoChunks(value: string, maxChunkChars: number) {
	const chunks: string[] = [];
	for (let index = 0; index < value.length; index += maxChunkChars) {
		chunks.push(value.slice(index, index + maxChunkChars));
	}
	return chunks;
}

function bundleKey(bundleName: string) {
	return `primed:bundle:${bundleName}`;
}

function bundleMetaKey(bundleName: string) {
	return `${bundleKey(bundleName)}:meta`;
}

function bundlePartKey(bundleName: string, index: number) {
	return `${bundleKey(bundleName)}:part:${index}`;
}

async function scanKeys(redis: Redis, pattern: string, limit: number) {
	let cursor = '0';
	const keys: string[] = [];
	let loops = 0;
	const maxLoops = 20; // Reduced from 200+ to avoid timeouts on production

	do {
		const [nextCursor, batch] = await redis.scan(cursor, {
			match: pattern,
			count: 500,
		});

		for (const key of batch || []) {
			keys.push(String(key));
			if (keys.length >= limit) return keys;
		}

		cursor = String(nextCursor || '0');
		loops += 1;
	} while (cursor !== '0' && loops < maxLoops);

	return keys;
}

function parseCacheKey(key: string): { source: 'finra' | 'sec'; entity: 'individual' | 'firm'; id: string } | null {
	const match = /^(finra|sec):(individual|firm):(\d{1,10})(?::.*)?$/i.exec(String(key || '').trim());
	if (!match) return null;
	const source = match[1].toLowerCase() as 'finra' | 'sec';
	const entity = match[2].toLowerCase() as 'individual' | 'firm';
	const id = match[3];
	return { source, entity, id };
}

function buildLocalCacheFilePath(source: 'finra' | 'sec', entity: 'individual' | 'firm', id: string) {
	const cacheDir = source === 'finra' ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
	const fileName = `api.${source === 'finra' ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov'}_search_${entity}_${id}.json`;
	return path.join(process.cwd(), 'data', 'national', cacheDir, fileName);
}

async function getCardUpdatedAt(card: CacheCard): Promise<number> {
	let newest = 0;
	for (const sourceEntry of card.sources) {
		const targetPath = buildLocalCacheFilePath(sourceEntry.source, card.entity, card.id);
		try {
			const stat = await fs.stat(targetPath);
			newest = Math.max(newest, Number(stat.mtimeMs || 0));
		} catch {
			// ignore missing local file
		}
	}
	return newest;
}

function parseFilterTokens(crdFilter: string) {
	return String(crdFilter || '')
		.trim()
		.split(/[\s,;]+/g)
		.map((value) => value.trim())
		.filter(Boolean);
}

function applyCardFilter<T extends { id: string }>(cards: T[], filterTokens: string[]) {
	if (!filterTokens.length) return cards;
	const exact = cards.filter((card) => filterTokens.some((token) => card.id === token));
	const partial = cards.filter((card) => filterTokens.some((token) => card.id.includes(token)) && !filterTokens.some((token) => card.id === token));
	return [...exact, ...partial];
}

export function shouldUseLocalFallback(cardCount: number, hasFilterTokens: boolean) {
	return false;
}

async function countInventoryTotals(rawDir = DEFAULT_EXTERNAL_RAW_DIR): Promise<InventoryTotals> {
	const rawCandidates = [path.resolve(rawDir), path.resolve(process.cwd(), 'data', 'raw')];
	const baseDir =
		rawCandidates.find((candidate) => {
			try {
				return fsSync.existsSync(candidate);
			} catch {
				return false;
			}
		}) || rawCandidates[0];

	const people = new Set<string>();
	const firms = new Set<string>();

	async function walk(dir: string) {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
			const match = /(?:finra|sec):(individual|firm):(\d+)/i.exec(entryPath);
			if (!match) continue;
			if (match[1].toLowerCase() === 'individual') people.add(match[2]);
			else firms.add(match[2]);
		}
	}

	await walk(baseDir);

	return {
		people: people.size,
		firms: firms.size,
		unique: people.size + firms.size,
		source: baseDir === path.resolve(DEFAULT_EXTERNAL_RAW_DIR) ? 'external-raw' : 'local-raw',
	};
}

async function listLocalNewestCards(maxCards = 10, crdFilter = '') {
	const sources: Array<{ source: 'finra' | 'sec'; dir: string; prefix: string }> = [
		{ source: 'finra', dir: path.join(process.cwd(), 'data', 'national', 'brokercheck.finra.org'), prefix: 'api.brokercheck.finra.org_search_' },
		{ source: 'sec', dir: path.join(process.cwd(), 'data', 'national', 'adviserinfo.sec.gov'), prefix: 'api.adviserinfo.sec.gov_search_' },
	];

	const cardMap = new Map<string, CacheCardWithMeta>();
	for (const sourceDef of sources) {
		let entries: string[] = [];
		try {
			entries = await fs.readdir(sourceDef.dir);
		} catch {
			entries = [];
		}

		for (const fileName of entries) {
			if (!fileName.startsWith(sourceDef.prefix) || !fileName.endsWith('.json')) continue;
			const match = /^api\.(?:brokercheck\.finra\.org|adviserinfo\.sec\.gov)_search_(individual|firm)_(\d{1,10})\.json$/i.exec(fileName);
			if (!match) continue;

			const entity = match[1].toLowerCase() as 'individual' | 'firm';
			const id = match[2];
			const filePath = path.join(sourceDef.dir, fileName);

			let updatedAt = 0;
			try {
				const stat = await fs.stat(filePath);
				updatedAt = Number(stat.mtimeMs || 0);
			} catch {
				updatedAt = 0;
			}

			const key = `${entity}:${id}`;
			const existing = cardMap.get(key) || {
				id,
				entity,
				files: 0,
				sources: [],
				updatedAt: 0,
			};

			existing.files += 1;
			existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
			if (!existing.sources.some((entry) => entry.source === sourceDef.source)) {
				existing.sources.push({ source: sourceDef.source, status: 'ok' });
			}

			cardMap.set(key, existing);
		}
	}

	const allCards = Array.from(cardMap.values())
		.sort((left, right) => right.updatedAt - left.updatedAt || Number(right.id) - Number(left.id))
		.map((card) => ({
			...card,
			sources: card.sources.sort((a, b) => a.source.localeCompare(b.source)),
		}));

	const filterTokens = parseFilterTokens(crdFilter);
	const filteredCards = applyCardFilter(allCards, filterTokens);
	const shownCards = filteredCards.slice(0, maxCards).map(({ updatedAt, ...card }) => card);

	return {
		ok: true,
		cards: shownCards,
		totalCards: allCards.length,
		totalCacheKeys: allCards.reduce((sum, card) => sum + card.files, 0),
		filteredTotalCards: filteredCards.length,
		inventoryTotals: await countInventoryTotals(),
		sourceMode: 'local-fallback' as const,
	};
}

async function readBuildManifestTotals() {
	if (manifestTotalsCache) return manifestTotalsCache;

	try {
		const raw = await fs.readFile(BUILD_MANIFEST_PATH, 'utf8');
		const parsed = JSON.parse(raw) as Record<string, number>;
		const cardIds = new Set<string>();
		const cardIndex = new Map<string, CacheCard>();
		let cacheKeys = 0;

		for (const entryPath of Object.keys(parsed)) {
			const match = /api\.(brokercheck\.finra\.org|adviserinfo\.sec\.gov)_search_(individual|firm)_(\d{1,10})\.json$/i.exec(entryPath);
			if (!match) continue;
			const host = match[1].toLowerCase();
			const entity = match[2].toLowerCase() as 'individual' | 'firm';
			const id = match[3];
			const source = host === 'brokercheck.finra.org' ? 'finra' : 'sec';
			cardIds.add(`${entity}:${id}`);
			upsertCardIndexEntry(cardIndex, { source, entity, id });
			cacheKeys += 1;
		}

		manifestCardIndexCache = cardIndex;
		manifestTotalsCache = {
			totalCards: cardIds.size,
			totalCacheKeys: cacheKeys,
		};
		return manifestTotalsCache;
	} catch {
		return null;
	}
}

async function readPrimedBundleTotals(redis: Redis, forceRefresh = false) {
	if (primedBundleTotalsCache && !forceRefresh) return primedBundleTotalsCache;

	const bundleNames = ['finra-individual', 'sec-individual', 'finra-firm', 'sec-firm'] as const;
	const cardIndex = new Map<string, CacheCard>();
	let totalCards = 0;
	let totalCacheKeys = 0;

	// Fast path: read only the 4 meta keys (each stores recordCount written at upload time)
	for (const bundleName of bundleNames) {
		const bundleKey = `primed:bundle:${bundleName}`;
		const metaRaw = await redis.get(`${bundleKey}:meta`).catch(() => null);
		if (!metaRaw) continue;
		const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
		const recordCount = Number(meta?.recordCount || 0);
		if (recordCount > 0) {
			totalCards += recordCount;
			totalCacheKeys += recordCount;
			// Build a minimal card index from bundle name (source + entity)
			const [source, entity] = bundleName.split('-') as ['finra' | 'sec', 'individual' | 'firm'];
			// Synthetic placeholder so filter logic has a fallback index entry type
			upsertCardIndexEntry(cardIndex, { source, entity, id: `__${bundleName}__` });
		}
	}

	if (totalCards === 0) return null;

	primedBundleCardIndexCache = cardIndex;
	primedBundleTotalsCache = { totalCards, totalCacheKeys };
	return primedBundleTotalsCache;
}

async function listCacheCards(maxCards = 200, crdFilter = '') {
	const redis = ensureRedisClient();
	if (!redis) {
		return listLocalNewestCards(maxCards, crdFilter);
	}

	const filterTokens = parseFilterTokens(crdFilter);

	const patterns = ['finra:individual:*', 'sec:individual:*', 'finra:firm:*', 'sec:firm:*'];

	const perPatternLimit = Math.max(100, DASHBOARD_REDIS_SCAN_CARD_LIMIT_PER_PATTERN);
	const keySet = new Set<string>();
	for (const pattern of patterns) {
		const keys = await scanKeys(redis, pattern, perPatternLimit);
		for (const key of keys) keySet.add(key);
	}

	const cardMap = new Map<string, CacheCard>();
	for (const key of keySet) {
		if (key.startsWith('sec:firm:summaryHtml:')) continue;
		if (key.startsWith('primed:bundle:')) continue;

		const parsed = parseCacheKey(key);
		if (!parsed) continue;

		const cardKey = `${parsed.entity}:${parsed.id}`;
		const existing = cardMap.get(cardKey) || {
			id: parsed.id,
			entity: parsed.entity,
			files: 0,
			sources: [],
		};

		existing.files += 1;
		if (!existing.sources.some((entry) => entry.source === parsed.source)) {
			existing.sources.push({ source: parsed.source, status: 'ok' });
		}

		cardMap.set(cardKey, existing);
	}

	const cards = Array.from(cardMap.values()).map((card) => ({
		...card,
		sources: card.sources.sort((a, b) => a.source.localeCompare(b.source)),
	}));

	const fallbackManifestTotals = null;
	if (shouldUseLocalFallback(cardMap.size, filterTokens.length > 0)) {
		const localListed = await listLocalNewestCards(maxCards, crdFilter);
		if ((localListed as any)?.totalCards > 0) {
			return localListed;
		}
	}
	let filteredCards = applyCardFilter(cards, filterTokens);

	if (filterTokens.length > 0 && filteredCards.length === 0) {
		filteredCards = [];
	}

	if (filterTokens.length > 0 && filteredCards.length > 0) {
		filteredCards = filteredCards;
	}

	const recencyBase =
		filteredCards.length <= DASHBOARD_RECENCY_MTIME_SAMPLE_LIMIT ?
			filteredCards
		:	[...filteredCards].sort((left, right) => Number(right.id) - Number(left.id)).slice(0, DASHBOARD_RECENCY_MTIME_SAMPLE_LIMIT);

	const recencyCards: CacheCardWithMeta[] = await Promise.all(
		recencyBase.map(async (card) => ({
			...card,
			updatedAt: await getCardUpdatedAt(card),
		})),
	);

	const sortedForDisplay = recencyCards.sort((left, right) => right.updatedAt - left.updatedAt || Number(right.id) - Number(left.id));

	if (!cards.length) {
		return listLocalNewestCards(maxCards, crdFilter);
	}

	const shownCards = await Promise.all(
		sortedForDisplay.slice(0, maxCards).map(async (card) => {
			const normalized = await normalizeCardSourcesForDisplay(card);
			const summary = await buildCardSummary(normalized);
			return normalizeCardForDisplay({ ...normalized, ...summary });
		}),
	);

	return {
		ok: true,
		cards: shownCards,
		totalCards: fallbackManifestTotals?.totalCards ?? cardMap.size,
		totalCacheKeys: fallbackManifestTotals?.totalCacheKeys ?? keySet.size,
		filteredTotalCards: filteredCards.length,
		inventoryTotals: await countInventoryTotals(),
		sourceMode: 'redis',
	};
}

async function listNewCrds() {
	const redis = ensureRedisClient();
	if (!redis) {
		return { ok: true, newCrds: [], isToday: false, lastChecked: null };
	}

	const patterns = ['finra:individual:*', 'sec:individual:*', 'finra:firm:*', 'sec:firm:*'];
	const perPatternLimit = Math.max(100, DASHBOARD_REDIS_SCAN_CARD_LIMIT_PER_PATTERN);
	const keySet = new Set<string>();

	for (const pattern of patterns) {
		const keys = await scanKeys(redis, pattern, perPatternLimit);
		for (const key of keys) keySet.add(key);
	}

	const cardMap = new Map<string, CacheCardWithMeta>();

	for (const key of keySet) {
		if (key.startsWith('sec:firm:summaryHtml:')) continue;
		if (key.startsWith('primed:bundle:')) continue;

		const parsed = parseCacheKey(key);
		if (!parsed) continue;

		const cardKey = `${parsed.entity}:${parsed.id}`;
		const existing = cardMap.get(cardKey) || {
			id: parsed.id,
			entity: parsed.entity,
			files: 0,
			sources: [],
			updatedAt: 0,
		};

		existing.files += 1;
		if (!existing.sources.some((entry) => entry.source === parsed.source)) {
			existing.sources.push({ source: parsed.source, status: 'ok' });
		}

		// Use Redis key creation time as updatedAt; default to current time
		const updatedAt = Date.now();
		if (updatedAt > existing.updatedAt) {
			existing.updatedAt = updatedAt;
		}

		cardMap.set(cardKey, existing);
	}

	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const todayMs = today.getTime();

	const todayCards = Array.from(cardMap.values())
		.filter((card) => card.updatedAt >= todayMs)
		.sort((a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id));

	const displayCards =
		todayCards.length > 0 ?
			todayCards
		:	Array.from(cardMap.values())
				.sort((a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id))
				.slice(0, 20);

	const formatted = await Promise.all(
		displayCards.map(async (card) => {
			// Skip semantic normalization for dashboard to avoid Redis lookups
			const normalized = normalizeCardForDisplay(card);
			const updatedDate = new Date(card.updatedAt);
			const daysAgo = Math.floor((todayMs - card.updatedAt) / (1000 * 60 * 60 * 24));
			const found =
				daysAgo === 0 ? 'today'
				: daysAgo === 1 ? 'yesterday'
				: `${daysAgo}d ago`;

			return {
				id: normalized.id,
				type: normalized.entity === 'individual' ? 'INDIVIDUAL' : 'FIRM',
				found,
				scopes: normalized.sources.map((s) => s.source.toUpperCase()).sort(),
				date: updatedDate.toISOString().split('T')[0],
			};
		}),
	);

	return {
		ok: true,
		newCrds: formatted,
		isToday: todayCards.length > 0,
		lastChecked: new Date().toISOString(),
		detectedCount: cardMap.size,
	};
}

async function uploadBundle(redis: Redis, bundleName: string, payloadBase64: string, recordCount = 0) {
	const key = bundleKey(bundleName);
	const metaKey = bundleMetaKey(bundleName);
	const chunks = splitIntoChunks(payloadBase64, PRIMED_REDIS_CHUNK_CHARS);

	if (chunks.length <= 1) {
		await redis.set(key, payloadBase64);
		await redis.del(metaKey).catch(() => 0);
		return { bundleName, mode: 'single', chunks: 1 };
	}

	await redis.del(key).catch(() => 0);
	for (let index = 0; index < chunks.length; index += 1) {
		await redis.set(bundlePartKey(bundleName, index), chunks[index]);
	}
	await redis.set(
		metaKey,
		JSON.stringify({
			encoding: 'base64-gzip',
			chunked: true,
			chunks: chunks.length,
			chunkChars: PRIMED_REDIS_CHUNK_CHARS,
			recordCount,
			updatedAt: new Date().toISOString(),
		}),
	);

	return { bundleName, mode: 'chunked', chunks: chunks.length };
}

async function syncExternalRawToLocal(externalRawDir: string) {
	const localRawDir = path.join(process.cwd(), 'data', 'raw');
	const stats = { copied: 0, skipped: 0, missingSource: false, source: externalRawDir, target: localRawDir };

	if (!(await exists(externalRawDir))) {
		stats.missingSource = true;
		return stats;
	}

	async function syncDir(sourceDir: string, targetDir: string): Promise<void> {
		await fs.mkdir(targetDir, { recursive: true });
		const entries = await fs.readdir(sourceDir, { withFileTypes: true });

		for (const entry of entries) {
			const sourcePath = path.join(sourceDir, entry.name);
			const targetPath = path.join(targetDir, entry.name);

			if (entry.isDirectory()) {
				await syncDir(sourcePath, targetPath);
				continue;
			}

			if (!entry.isFile()) continue;

			let shouldCopy = true;
			if (await exists(targetPath)) {
				const [sourceStat, targetStat] = await Promise.all([fs.stat(sourcePath), fs.stat(targetPath)]);
				shouldCopy = sourceStat.size !== targetStat.size || sourceStat.mtimeMs > targetStat.mtimeMs;
			}

			if (!shouldCopy) {
				stats.skipped += 1;
				continue;
			}

			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.copyFile(sourcePath, targetPath);
			stats.copied += 1;
		}
	}

	await syncDir(externalRawDir, localRawDir);
	return stats;
}

async function fetchCrdsToCacheAndRedis(targets: FetchTarget[], options: { includePayload?: boolean } = {}) {
	const { includePayload = false } = options;
	const results: FetchResultItem[] = [];
	const nationalRoot = path.join(process.cwd(), 'data', 'national');
	const rawRoot = path.join(process.cwd(), 'data', 'raw');

	for (const target of targets) {
		const crd = target.crd;
		const isFinra = target.source === 'finra';
		const isIndividual = target.type === 'individual';
		const url =
			isFinra && isIndividual ? `https://api.brokercheck.finra.org/search/individual/${crd}?hl=true&includePrevious=true&wt=json`
			: isFinra && !isIndividual ? `https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&wt=json`
			: !isFinra && isIndividual ? `https://api.adviserinfo.sec.gov/search/individual/${crd}?hl=true&includePrevious=true&wt=json`
			: `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`;
		const cacheFileName = `api.${isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov'}_search_${target.type}_${crd}.json`;
		const cacheDir = isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
		const redisKey =
			target.type === 'individual' ? `${target.source}:individual:${crd}`
			: target.source === 'finra' ? `finra:firm:${crd}`
			: `sec:firm:${crd}`;
		const redisAliases: string[] = [];

		try {
			const payload = await fetchJson(url);
			if (!isValidFetchedPayload(payload)) {
				results.push({
					crd,
					source: target.source,
					type: target.type,
					url,
					cacheFile: path.join(nationalRoot, cacheDir, cacheFileName),
					redisKey,
					status: 'error',
					redisWrite: 'not-attempted',
					error: 'invalid-payload-shape',
				});
				continue;
			}

			const nationalFile = path.join(nationalRoot, cacheDir, cacheFileName);
			const rawFile = path.join(rawRoot, cacheDir, cacheFileName);
			let fileWriteError = '';
			try {
				await Promise.all([writeJsonFile(nationalFile, payload), writeJsonFile(rawFile, payload)]);
			} catch (writeErr: any) {
				fileWriteError = writeErr?.message || String(writeErr);
			}

			const redisWriteResults = [await setStringIfValid(redisKey, JSON.stringify(payload), 60 * 60 * 24)];
			for (const aliasKey of redisAliases) {
				redisWriteResults.push(await setStringIfValid(aliasKey, JSON.stringify(payload), 60 * 60 * 24));
			}
			const redisWrite = redisWriteResults.join(',');
			const persisted = redisWriteResults.some((status) => status === 'written') || !fileWriteError;

			results.push({
				crd,
				source: target.source,
				type: target.type,
				url,
				cacheFile: nationalFile,
				redisKey: [redisKey, ...redisAliases].join('|'),
				status: persisted ? 'ok' : 'error',
				redisWrite,
				error: persisted ? undefined : `persist-failed:${fileWriteError || redisWrite}`,
				...(includePayload ? { payload } : {}),
			});
		} catch (error: any) {
			results.push({
				crd,
				source: target.source,
				type: target.type,
				url,
				cacheFile: path.join(nationalRoot, cacheDir, cacheFileName),
				redisKey,
				status: 'error',
				redisWrite: 'not-attempted',
				error: error?.message || String(error),
				...(includePayload ? { payload: null } : {}),
			});
		}
	}

	const successCount = results.filter((item) => item.status === 'ok').length;
	const errorCount = results.length - successCount;
	const uniqueCrds = new Set(results.map((item) => item.crd));

	return {
		summary: {
			crdCount: uniqueCrds.size,
			requests: results.length,
			successCount,
			errorCount,
		},
		results,
	};
}

async function deployPrimedBundlesToRedis() {
	const redis = ensureRedisClient();
	if (!redis) {
		throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for deployment.');
	}

	const primedDir = path.join(process.cwd(), 'data', 'national', 'primed-cache');
	const files = await fs.readdir(primedDir).catch(() => []);
	const bundleNames = files
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.replace(/\.json$/i, ''))
		.filter((name) => !/(?:^|[-_.])(manifest|index|meta)$/i.test(name))
		.sort((a, b) => a.localeCompare(b));

	const uploads: Array<{ bundleName: string; mode: string; chunks: number }> = [];
	for (const bundleName of bundleNames) {
		const binPath = path.join(primedDir, `${bundleName}.bin`);
		const jsonPath = path.join(primedDir, `${bundleName}.json`);

		if (await exists(binPath)) {
			const payload = await fs.readFile(binPath);
			// Decode to count records for the meta key
			let recordCount = 0;
			try {
				const json = zlib.gunzipSync(payload).toString('utf8');
				recordCount = Object.keys(JSON.parse(json)).length;
			} catch {
				/* ignore */
			}
			uploads.push(await uploadBundle(redis, bundleName, payload.toString('base64'), recordCount));
			continue;
		}

		if (await exists(jsonPath)) {
			const jsonRaw = await fs.readFile(jsonPath, 'utf8');
			let recordCount = 0;
			try {
				recordCount = Object.keys(JSON.parse(jsonRaw)).length;
			} catch {
				/* ignore */
			}
			const gz = zlib.gzipSync(Buffer.from(jsonRaw, 'utf8'));
			uploads.push(await uploadBundle(redis, bundleName, gz.toString('base64'), recordCount));
		}
	}

	return {
		bundleCount: uploads.length,
		uploads,
	};
}

export async function POST(request: NextRequest) {
	let body: RefreshRequestBody;
	try {
		body = (await request.json()) as RefreshRequestBody;
	} catch {
		return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
	}

	const action = body.action;
	if (!action || !['fetch-crds', 'sync-and-deploy-primed', 'list-cache-cards', 'list-new-crds'].includes(action)) {
		return NextResponse.json({ ok: false, error: 'invalid-action' }, { status: 400 });
	}

	try {
		if (action === 'list-new-crds') {
			const listed = await listNewCrds();
			return NextResponse.json({
				ok: true,
				action,
				...listed,
				at: new Date().toISOString(),
			});
		}

		if (action === 'list-cache-cards') {
			const maxCards = Math.max(1, Math.min(1000, Number(body.maxCards || 10)));
			const listed = await listCacheCards(maxCards, String(body.crdFilter || ''));
			if ((listed as any).ok === false) {
				return NextResponse.json(
					{ ok: false, error: (listed as any).error || 'list-cache-cards-failed', cards: [], shownCount: 0, totalCount: 0, totalCacheKeys: 0 },
					{ status: 200 },
				);
			}
			return NextResponse.json({
				ok: true,
				action,
				cards: listed.cards,
				shownCount: listed.cards.length,
				totalCount: listed.totalCards,
				totalCacheKeys: listed.totalCacheKeys,
				filteredTotalCount: listed.filteredTotalCards,
				sourceMode: listed.sourceMode,
				at: new Date().toISOString(),
			});
		}

		if (action === 'fetch-crds') {
			const maxCrds = Number(body.maxCrds || 30);
			const queries = parseQueries(body.queries ?? body.crds, maxCrds);
			const providedCrds = parseCrds(body.crds, maxCrds);
			const resolvedFromQueries = await resolveCrdsFromQueries(queries, maxCrds);

			const targetMap = new Map<string, FetchTarget>();
			for (const target of resolvedFromQueries.targets) {
				targetMap.set(`${target.source}:${target.type}:${target.crd}`, target);
			}

			for (const crd of providedCrds) {
				targetMap.set(`finra:individual:${crd}`, { crd, source: 'finra', type: 'individual' });
				targetMap.set(`sec:individual:${crd}`, { crd, source: 'sec', type: 'individual' });
				targetMap.set(`finra:firm:${crd}`, { crd, source: 'finra', type: 'firm' });
				targetMap.set(`sec:firm:${crd}`, { crd, source: 'sec', type: 'firm' });
			}

			const targets = Array.from(targetMap.values());
			if (!targets.length) {
				return NextResponse.json(
					{
						ok: false,
						error: 'no-valid-crds',
						queries,
						resolvedQueryCount: resolvedFromQueries.resolution.filter((entry) => entry.crdCount > 0).length,
						resolution: resolvedFromQueries.resolution,
					},
					{ status: 400 },
				);
			}

			const fetched = await fetchCrdsToCacheAndRedis(targets, { includePayload: Boolean(body.includePayload) });
			return NextResponse.json({
				ok: true,
				action,
				queries,
				resolvedQueryCount: resolvedFromQueries.resolution.filter((entry) => entry.crdCount > 0).length,
				resolution: resolvedFromQueries.resolution,
				...fetched,
				at: new Date().toISOString(),
			});
		}

		const externalRawDir = String(body.externalRawDir || process.env.EXTERNAL_RAW_DIR || DEFAULT_EXTERNAL_RAW_DIR).trim();
		const syncResult = await syncExternalRawToLocal(externalRawDir);
		const deployResult = await deployPrimedBundlesToRedis();

		return NextResponse.json({
			ok: true,
			action,
			syncResult,
			deployResult,
			at: new Date().toISOString(),
		});
	} catch (error: any) {
		return NextResponse.json(
			{
				ok: false,
				error: error?.message || String(error),
				at: new Date().toISOString(),
			},
			{ status: 500 },
		);
	}
}
