import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Redis } from '@upstash/redis';
import { cachedFetch } from '@/lib/simpleCache';
import { normalizeIndividualDetailPayload } from '@/lib/individualDetail';
import { setStringIfValid } from '@/lib/redisCache';
import { getFullGraph, saveGraph } from '@/lib/graphStore';
import { getRecentSeedsFromStore, rememberRecentSeed } from '@/lib/seedStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const DEFAULT_EXTERNAL_RAW_DIR = '/home/lenny/Dev/webDev/Data-finra-sec/data/raw';
const PRIMED_REDIS_CHUNK_CHARS = Number(process.env.PRIMED_REDIS_CHUNK_CHARS || 700_000);
const DASHBOARD_REDIS_SCAN_CARD_LIMIT_PER_PATTERN = Number(process.env.DASHBOARD_REDIS_SCAN_CARD_LIMIT_PER_PATTERN || 100_000);
const DASHBOARD_RECENCY_MTIME_SAMPLE_LIMIT = Number(process.env.DASHBOARD_RECENCY_MTIME_SAMPLE_LIMIT || 2_000);
const DASHBOARD_REDIS_MIN_CARD_COUNT = Math.max(1_000, Number(process.env.DASHBOARD_REDIS_MIN_CARD_COUNT || 1_000) || 1_000);
const DASHBOARD_QUERY_RESOLVE_CONCURRENCY = 1;
const DASHBOARD_DETAIL_FETCH_CONCURRENCY = 1;
const DASHBOARD_DETAIL_FETCH_DELAY_MS = Math.max(2000, Number(process.env.DASHBOARD_DETAIL_FETCH_DELAY_MS || 2000) || 2000);
const DASHBOARD_DETAIL_FETCH_JITTER_MS = Math.max(3000, Number(process.env.DASHBOARD_DETAIL_FETCH_JITTER_MS || 5000) || 5000);
const DASHBOARD_429_COOLDOWN_MIN_MS = 6 * 60 * 1000;
const DASHBOARD_429_COOLDOWN_MAX_MS = 9 * 60 * 1000;
const DASHBOARD_SEARCH_FETCH_TIMEOUT_MS = Math.max(2_000, Number(process.env.DASHBOARD_SEARCH_FETCH_TIMEOUT_MS || 8_000) || 8_000);
const DASHBOARD_DETAIL_FETCH_TIMEOUT_MS = Math.max(2_000, Number(process.env.DASHBOARD_DETAIL_FETCH_TIMEOUT_MS || 12_000) || 12_000);
const DASHBOARD_NATIVE_REDIS_KEY_CACHE_MS = Math.max(0, Number(process.env.DASHBOARD_NATIVE_REDIS_KEY_CACHE_MS || 15_000) || 15_000);
const BUILD_MANIFEST_PATH = path.join(process.cwd(), 'data', 'build_manifest.json');
const CRD_LOG_PATH = path.join(process.cwd(), 'data', 'crd-log.json');

let manifestTotalsCache: { totalCards: number; totalCacheKeys: number } | null = null;
let primedBundleTotalsCache: { totalCards: number; totalCacheKeys: number } | null = null;
let nativeRedisKeyCache: { keys: string[]; fetchedAt: number } | null = null;

export function resetDashboardInventoryCaches() {
	manifestTotalsCache = null;
	primedBundleTotalsCache = null;
	nativeRedisKeyCache = null;
}

type CrdLogEntry = { id: number; name: string };
type CrdLog = { firms: CrdLogEntry[]; individuals: CrdLogEntry[] };

let crdLogCache: CrdLog | null = null;
let crdLogNameMapCache: Map<string, string> | null = null;

export function resetCrdLogCache() {
	crdLogCache = null;
	crdLogNameMapCache = null;
}

function loadCrdLog(): CrdLog {
	if (crdLogCache) return crdLogCache;
	try {
		const raw = fsSync.readFileSync(CRD_LOG_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		const normEntries = (arr: unknown[]): CrdLogEntry[] =>
			(Array.isArray(arr) ? arr : [])
				.map((entry) =>
					typeof entry === 'object' && entry !== null ? { id: Number((entry as any).id), name: String((entry as any).name || '') } : { id: Number(entry), name: '' },
				)
				.filter((e) => Number.isFinite(e.id) && e.id > 0);
		crdLogCache = {
			firms: normEntries(parsed.firms),
			individuals: normEntries(parsed.individuals),
		};
	} catch {
		crdLogCache = { firms: [], individuals: [] };
	}
	return crdLogCache;
}

function getCrdLogNameMap(): Map<string, string> {
	if (crdLogNameMapCache) return crdLogNameMapCache;
	const log = loadCrdLog();
	crdLogNameMapCache = new Map<string, string>();
	for (const entry of log.firms) if (entry.name) crdLogNameMapCache.set(`firm:${entry.id}`, entry.name);
	for (const entry of log.individuals) if (entry.name) crdLogNameMapCache.set(`individual:${entry.id}`, entry.name);
	return crdLogNameMapCache;
}

function buildKeySetFromCrdLog(): Set<string> {
	const log = loadCrdLog();
	const keySet = new Set<string>();
	for (const entry of log.individuals) {
		keySet.add(`finra:individual:${entry.id}`);
		keySet.add(`sec:individual:${entry.id}`);
	}
	for (const entry of log.firms) {
		keySet.add(`finra:firm:${entry.id}`);
		keySet.add(`sec:firm:${entry.id}`);
	}
	return keySet;
}
let manifestCardIndexCache: Map<string, CacheCard> | null = null;
let primedBundleCardIndexCache: Map<string, CacheCard> | null = null;

type DashboardAction = 'fetch-crds' | 'sync-and-deploy-primed' | 'list-cache-cards' | 'list-new-crds' | 'get-inventory-counter' | 'increment-inventory-counter';

type RefreshRequestBody = {
	action?: DashboardAction;
	crds?: string[] | string;
	queries?: string[] | string;
	externalRawDir?: string;
	maxCrds?: number;
	includePayload?: boolean;
	maxCards?: number;
	crdFilter?: string;
	amount?: number;
};

type FetchResultItem = {
	crd: string;
	source: 'finra' | 'sec';
	type: 'individual' | 'firm';
	url: string;
	cacheFile: string;
	redisKey: string;
	status: 'ok' | 'skipped' | 'error';
	redisWrite: string;
	cardKey?: string;
	newSourceSaved?: boolean;
	newRecordSaved?: boolean;
	error?: string;
	skipReason?: string;
	payload?: unknown;
};

type FetchTarget = {
	crd: string;
	source: 'finra' | 'sec';
	type: 'individual' | 'firm';
};

type MainAppGraphArtifacts = {
	nodes: Record<string, any>[];
	links: Record<string, any>[];
};

type MainAppPublishSummary = {
	rememberedSeeds: number;
	nodesAdded: number;
	nodesUpdated: number;
	linksAdded: number;
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
	source: 'external-raw' | 'local-raw' | 'redis' | 'primed-bundle';
};

export function buildInventoryTotalsFromCards(cards: Array<Pick<CacheCard, 'id' | 'entity'> & Partial<CacheCard>>, source: InventoryTotals['source'] = 'redis'): InventoryTotals {
	const people = new Set<string>();
	const firms = new Set<string>();

	for (const card of cards) {
		if (card.entity === 'individual') people.add(card.id);
		else firms.add(card.id);
	}

	return {
		people: people.size,
		firms: firms.size,
		unique: people.size + firms.size,
		source,
	};
}

export function collectInventoryTotalsFromCacheKeys(keys: string[], source: InventoryTotals['source'] = 'redis'): InventoryTotals {
	const people = new Set<string>();
	const firms = new Set<string>();

	for (const key of keys) {
		const parsed = parseCacheKey(key);
		if (!parsed) continue;
		if (parsed.entity === 'individual') people.add(parsed.id);
		else firms.add(parsed.id);
	}

	return {
		people: people.size,
		firms: firms.size,
		unique: people.size + firms.size,
		source,
	};
}

export function filterRecentCardsForDisplay<T extends { updatedAt?: number }>(cards: T[], options: { now?: number; lookbackDays?: number } = {}): T[] {
	const now = Number(options.now ?? Date.now());
	const lookbackDays = Math.max(1, Number(options.lookbackDays ?? 7));
	const cutoff = now - lookbackDays * 24 * 60 * 60 * 1000;

	return [...cards]
		.filter((card) => Number(card.updatedAt || 0) >= cutoff)
		.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0) || String(right as any).localeCompare(String(left as any)));
}

export function sortLatestCardsForDisplay<T extends { updatedAt?: number; id?: string }>(cards: T[], options: { maxCards?: number } = {}): T[] {
	const maxCards = Math.max(1, Number(options.maxCards ?? 20));

	return [...cards]
		.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0) || String(right.id || '').localeCompare(String(left.id || '')))
		.slice(0, maxCards);
}

export function buildPrimedBundleInventoryTotals(bundleCounts: Array<{ bundleName: string; recordCount: number }>): InventoryTotals {
	let people = 0;
	let firms = 0;

	for (const entry of bundleCounts) {
		const bundleName = String(entry.bundleName || '').toLowerCase();
		if (bundleName.includes('individual')) people = Math.max(people, Number(entry.recordCount || 0));
		if (bundleName.includes('firm')) firms = Math.max(firms, Number(entry.recordCount || 0));
	}

	return {
		people,
		firms,
		unique: people + firms,
		source: 'primed-bundle',
	};
}

function hasMeaningfulInventoryTotals(totals: InventoryTotals | null | undefined) {
	return Number(totals?.people || 0) > 0 || Number(totals?.firms || 0) > 0 || Number(totals?.unique || 0) > 0;
}

export function resolveDashboardInventoryTotals(
	redisTotals: InventoryTotals,
	cachedDedupedTotals: InventoryTotals | null,
	rawFallbackTotals: InventoryTotals | null,
): InventoryTotals {
	if (hasMeaningfulInventoryTotals(redisTotals)) return redisTotals;
	if (hasMeaningfulInventoryTotals(cachedDedupedTotals)) return cachedDedupedTotals ?? redisTotals;
	return rawFallbackTotals ?? cachedDedupedTotals ?? redisTotals;
}

export function chooseDisplayInventoryTotals(redisTotals: InventoryTotals, primedTotals: InventoryTotals | null): InventoryTotals {
	return resolveDashboardInventoryTotals(redisTotals, primedTotals, null);
}

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

function hasFirmFinraPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	const basic = node.basicInformation || {};
	if (node.hasFinraData === true) return true;
	const bcScope = normalizeScopeValue(node?.bcScope || basic?.bcScope || '');
	if (bcScope) return true;
	if (Boolean(String(node?.bdSECNumber || node?.bdSecNumber || basic?.bdSECNumber || basic?.bdSecNumber || '').trim())) return true;
	if (Boolean(String(node?.districtName || basic?.districtName || '').trim())) return true;
	if (hasApprovedSro(node?.registeredSROs) || hasApprovedSro(node?.registrations)) return true;
	if (
		String(node?.isLegacy || '')
			.trim()
			.toUpperCase() === 'Y'
	)
		return true;
	return false;
}

function hasFirmSecPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	const basic = node.basicInformation || {};
	if (node.hasSecData === true) return true;
	const iaScope = normalizeScopeValue(node?.iaScope || basic?.iaScope || node?.firmStatus || basic?.firmStatus || '');
	if (iaScope) return true;
	if (Boolean(String(node?.iaSECNumber || node?.iaSecNumber || basic?.iaSECNumber || basic?.iaSecNumber || '').trim())) return true;
	if (
		Array.isArray(node?.registrations) &&
		node.registrations.some((entry: any) => /approved|active|current|registered/i.test(String(entry?.registrationStatus || entry?.status || '')))
	) {
		return true;
	}
	return false;
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

function parseFirmDetailPayload(data: unknown, contentKey: 'content' | 'iacontent') {
	if (!data) return null;

	const normalizeCandidate = (candidate: unknown) => {
		if (!isPlainObject(candidate)) return null;
		return candidate as Record<string, any>;
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

		const looksLikeDetail = data.basicInformation || data.firmId || data.iaSECNumber || data.iaSecNumber || data.bdSECNumber || data.bdSecNumber || data.bcScope || data.iaScope;
		if (looksLikeDetail) return normalizeCandidate(data);
	}

	return null;
}

function mergeUniqueGraphArrays(existingValue: unknown[], incomingValue: unknown[]) {
	const merged = [...existingValue];
	const seen = new Set(existingValue.map((entry) => JSON.stringify(entry)));
	for (const entry of incomingValue) {
		const key = JSON.stringify(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(entry);
	}
	return merged;
}

function mergeGraphValue(existingValue: unknown, incomingValue: unknown): unknown {
	if (incomingValue == null || incomingValue === '') return existingValue;
	if (Array.isArray(incomingValue)) {
		if (!incomingValue.length) return existingValue;
		return Array.isArray(existingValue) ? mergeUniqueGraphArrays(existingValue, incomingValue) : incomingValue;
	}
	if (isPlainObject(incomingValue)) {
		if (isPlainObject(existingValue)) {
			const merged: Record<string, any> = { ...existingValue };
			for (const [key, value] of Object.entries(incomingValue)) {
				merged[key] = mergeGraphValue(merged[key], value);
			}
			return merged;
		}
		return incomingValue;
	}
	return incomingValue;
}

function mergeGraphNode(existingNode: Record<string, any>, incomingNode: Record<string, any>) {
	const merged: Record<string, any> = { ...existingNode };
	for (const [key, value] of Object.entries(incomingNode)) {
		merged[key] = mergeGraphValue(merged[key], value);
	}
	return merged;
}

function buildEmploymentGraphArtifacts(detail: Record<string, any>, personId: string): MainAppGraphArtifacts {
	const nodes: Record<string, any>[] = [];
	const links: Record<string, any>[] = [];
	const seenFirmIds = new Set<string>();
	const employments = [
		...(Array.isArray(detail?.currentEmployments) ? detail.currentEmployments : []),
		...(Array.isArray(detail?.previousEmployments) ? detail.previousEmployments.map((employment: any) => ({ ...employment, _isCurrent: false })) : []),
		...(Array.isArray(detail?.currentIAEmployments) ? detail.currentIAEmployments : []),
		...(Array.isArray(detail?.previousIAEmployments) ? detail.previousIAEmployments.map((employment: any) => ({ ...employment, _isCurrent: false })) : []),
	];

	for (const employment of employments) {
		const firmId = String(employment?.firm_id || employment?.firmId || employment?.firmIdNumber || '').trim();
		if (!firmId) continue;
		const firmNodeId = `firm:${firmId}`;
		if (!seenFirmIds.has(firmNodeId)) {
			seenFirmIds.add(firmNodeId);
			nodes.push({
				id: firmNodeId,
				label: employment?.firm_name || employment?.firmName || `Firm ${firmId}`,
				group: 'firm',
				firmId,
				_source: 'dashboard-fetch',
				discovered_by_crd: personId,
			});
		}
		links.push({
			source: personId,
			target: firmNodeId,
			relationship: employment?._isCurrent === false ? 'previous_employed_by' : 'employed_by',
			isCurrent: employment?._isCurrent !== false,
		});
	}

	return { nodes, links };
}

export function buildMainAppGraphArtifactsFromFetchedPayload(payload: unknown, target: FetchTarget): MainAppGraphArtifacts {
	if (target.type === 'individual') {
		const detail = parseIndividualDetailPayload(payload, target.source === 'finra' ? 'content' : 'iacontent', target.crd) as Record<string, any> | null;
		if (!detail) return { nodes: [], links: [] };
		const basic = detail?.basicInformation || {};
		const personId = `person:${target.crd}`;
		const personNode: Record<string, any> = {
			id: personId,
			label: [basic?.firstName, basic?.middleName, basic?.lastName].filter(Boolean).join(' ') || basic?.name || detail?.name || null,
			group: 'individual',
			crd: target.crd,
			_source: 'dashboard-fetch',
			basicInformation: basic || null,
			bcScope: detail?.bcScope ?? basic?.bcScope ?? null,
			iaScope: detail?.iaScope ?? basic?.iaScope ?? null,
			currentEmployments: Array.isArray(detail?.currentEmployments) ? detail.currentEmployments : [],
			previousEmployments: Array.isArray(detail?.previousEmployments) ? detail.previousEmployments : [],
			currentIAEmployments: Array.isArray(detail?.currentIAEmployments) ? detail.currentIAEmployments : [],
			previousIAEmployments: Array.isArray(detail?.previousIAEmployments) ? detail.previousIAEmployments : [],
			registrationCount: detail?.registrationCount || null,
			disclosures: detail?.disclosures || null,
			iaDisclosures: detail?.iaDisclosures || null,
			hasFinraData: hasIndividualFinraPresence(detail),
			hasSecData: hasIndividualSecPresence(detail),
			_trustedCurrentRelationshipData: Boolean(
				(Array.isArray(detail?.currentEmployments) && detail.currentEmployments.length) ||
				(Array.isArray(detail?.previousEmployments) && detail.previousEmployments.length) ||
				(Array.isArray(detail?.currentIAEmployments) && detail.currentIAEmployments.length) ||
				(Array.isArray(detail?.previousIAEmployments) && detail.previousIAEmployments.length) ||
				detail?.registrationCount,
			),
		};
		const employmentArtifacts = buildEmploymentGraphArtifacts(detail as Record<string, any>, personId);
		return {
			nodes: [personNode, ...employmentArtifacts.nodes],
			links: employmentArtifacts.links,
		};
	}

	const detail = parseFirmDetailPayload(payload, target.source === 'finra' ? 'content' : 'iacontent') as Record<string, any> | null;
	if (!detail) return { nodes: [], links: [] };
	const basic = detail?.basicInformation || {};
	const firmNodeId = `firm:${target.crd}`;
	const nodes: Record<string, any>[] = [
		{
			id: firmNodeId,
			label: basic?.firmName || detail?.firmName || detail?.name || null,
			group: 'firm',
			firmId: target.crd,
			_source: 'dashboard-fetch',
			basicInformation: basic || null,
			bcScope: detail?.bcScope ?? basic?.bcScope ?? null,
			iaScope: detail?.iaScope ?? basic?.iaScope ?? detail?.firmStatus ?? basic?.firmStatus ?? null,
			firmStatus: detail?.firmStatus ?? basic?.firmStatus ?? null,
			registrations: Array.isArray(detail?.registrations) ? detail.registrations : [],
			registeredSROs: Array.isArray(detail?.registeredSROs) ? detail.registeredSROs : [],
			hasFinraData: hasFirmFinraPresence(detail),
			hasSecData: hasFirmSecPresence(detail),
		},
	];
	const links: Record<string, any>[] = [];
	const seenOwnerIds = new Set<string>();
	for (const owner of Array.isArray(detail?.directOwners) ? detail.directOwners : []) {
		const ownerCrd = String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
		if (!ownerCrd) continue;
		const personId = `person:${ownerCrd}`;
		if (!seenOwnerIds.has(personId)) {
			seenOwnerIds.add(personId);
			nodes.push({
				id: personId,
				label: owner?.legalName || owner?.name || `Node person:${ownerCrd}`,
				group: 'individual',
				crd: ownerCrd,
				_source: 'dashboard-fetch',
				stub: true,
				discovered_by_crd: firmNodeId,
			});
		}
		links.push({ source: personId, target: firmNodeId, relationship: 'controls' });
	}
	return { nodes, links };
}

function getGraphLinkKey(link: Record<string, any>) {
	const source = String(link?.source?.id ?? link?.source ?? '').trim();
	const target = String(link?.target?.id ?? link?.target ?? '').trim();
	const relationship = String(link?.relationship || '').trim();
	const startDate = String(link?.startDate || link?.start || '').trim();
	const endDate = String(link?.endDate || link?.end || '').trim();
	const isCurrent = String(link?.isCurrent ?? '').trim();
	return [source, target, relationship, startDate, endDate, isCurrent].join('|');
}

export async function publishFetchedRecordsToMainApp(
	records: Array<Pick<FetchResultItem, 'crd' | 'type' | 'status' | 'payload'> & { source: 'finra' | 'sec' }>,
): Promise<MainAppPublishSummary> {
	const successfulRecords = records.filter((record) => record.status === 'ok' && record.payload);
	if (!successfulRecords.length) {
		return { rememberedSeeds: 0, nodesAdded: 0, nodesUpdated: 0, linksAdded: 0 };
	}

	let rememberedSeeds = 0;
	for (const record of successfulRecords) {
		try {
			await rememberRecentSeed(record.type, record.crd);
			rememberedSeeds += 1;
		} catch {
			// ignore seed-store write failures so fetch results still succeed
		}
	}

	const graph = await getFullGraph();
	const nodes = Array.isArray(graph?.nodes) ? [...graph.nodes] : [];
	const links = Array.isArray(graph?.links) ? [...graph.links] : [];
	const nodeIndex = new Map<string, number>(nodes.map((node: any, index: number) => [String(node?.id || '').trim(), index]));
	const linkKeys = new Set(links.map((link: any) => getGraphLinkKey(link)));
	let nodesAdded = 0;
	let nodesUpdated = 0;
	let linksAdded = 0;

	for (const record of successfulRecords) {
		const artifacts = buildMainAppGraphArtifactsFromFetchedPayload(record.payload, {
			crd: record.crd,
			source: record.source,
			type: record.type,
		});

		for (const node of artifacts.nodes) {
			const nodeId = String(node?.id || '').trim();
			if (!nodeId) continue;
			const existingIndex = nodeIndex.get(nodeId);
			if (existingIndex == null) {
				nodeIndex.set(nodeId, nodes.push(node) - 1);
				nodesAdded += 1;
				continue;
			}
			const mergedNode = mergeGraphNode(nodes[existingIndex] || {}, node);
			if (JSON.stringify(mergedNode) !== JSON.stringify(nodes[existingIndex])) {
				nodes[existingIndex] = mergedNode;
				nodesUpdated += 1;
			}
		}

		for (const link of artifacts.links) {
			const linkKey = getGraphLinkKey(link);
			if (!linkKey || linkKeys.has(linkKey)) continue;
			linkKeys.add(linkKey);
			links.push(link);
			linksAdded += 1;
		}
	}

	if (nodesAdded || nodesUpdated || linksAdded) {
		await saveGraph({
			...graph,
			nodes,
			links,
			meta: {
				...(graph?.meta || {}),
				updatedAt: new Date().toISOString(),
			},
		});
	}

	return { rememberedSeeds, nodesAdded, nodesUpdated, linksAdded };
}

export function fetchedPayloadHasSourceCoverage(payload: unknown, target: { source: 'finra' | 'sec'; type: 'individual' | 'firm'; crd?: string }) {
	if (target.type === 'individual') {
		const detail = parseIndividualDetailPayload(payload, target.source === 'finra' ? 'content' : 'iacontent', String(target.crd || '').trim());
		if (!detail) return false;
		return target.source === 'finra' ? hasIndividualFinraPresence(detail) : hasIndividualSecPresence(detail);
	}

	const detail = parseFirmDetailPayload(payload, target.source === 'finra' ? 'content' : 'iacontent');
	if (!detail) return false;
	return target.source === 'finra' ? hasFirmFinraPresence(detail) : hasFirmSecPresence(detail);
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

export function buildCacheCardsFromRedisKeys(keys: string[], nameMap: Map<string, string> = new Map()) {
	const cardMap = new Map<string, CacheCard>();
	const seenRecordKeys = new Set<string>();

	for (const key of keys) {
		if (String(key || '').startsWith('sec:firm:summaryHtml:')) continue;
		if (String(key || '').startsWith('primed:bundle:')) continue;

		const parsed = parseCacheKey(key);
		if (!parsed) continue;
		const normalizedRecordKey = `${parsed.source}:${parsed.entity}:${parsed.id}`;
		if (seenRecordKeys.has(normalizedRecordKey)) continue;
		seenRecordKeys.add(normalizedRecordKey);

		const cardKey = `${parsed.entity}:${parsed.id}`;
		const existing = cardMap.get(cardKey) || {
			id: parsed.id,
			entity: parsed.entity,
			files: 0,
			sources: [],
			name: nameMap.get(cardKey) || undefined,
		};

		existing.files += 1;
		if (!existing.sources.some((entry) => entry.source === parsed.source)) {
			existing.sources.push({ source: parsed.source, status: 'ok' });
		}

		cardMap.set(cardKey, existing);
	}

	return Array.from(cardMap.values()).map((card) => ({
		...card,
		sources: card.sources.sort((a, b) => a.source.localeCompare(b.source)),
	}));
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

export function extractCardSummaryFields(detail: Record<string, any>, fallbackCrd = '', sourceHint?: 'finra' | 'sec') {
	const basic = (detail?.basicInformation || {}) as Record<string, any>;
	const candidateName =
		String(basic.name || '').trim() ||
		[basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ').trim() ||
		String(detail?.legalName || '').trim() ||
		String(detail?.firmName || '').trim() ||
		String(detail?.name || '').trim() ||
		'';

	const memberSince = findFirstDate(detail) || findFirstDate(basic) || null;
	const finraStatus = sourceHint === 'sec' ? null : classifyStatusText(detail?.bcScope || basic?.bcScope || detail?.registrationStatus || detail?.status);
	const secStatus = sourceHint === 'finra' ? null : classifyStatusText(detail?.iaScope || basic?.iaScope || detail?.registrationStatus || detail?.status);

	return {
		name: candidateName || (fallbackCrd ? `Record ${fallbackCrd}` : ''),
		statusText:
			[sourceHint !== 'sec' && finraStatus ? 'FINRA ' + finraStatus : null, sourceHint !== 'finra' && secStatus ? 'SEC ' + secStatus : null].filter(Boolean).join(' • ') || null,
		memberSince,
	};
}

async function buildCardSummary(card: CacheCard) {
	const summary: Pick<CacheCard, 'name' | 'statusText' | 'memberSince'> = {};

	for (const sourceEntry of card.sources) {
		const detail = await loadCachedIndividualPayload(sourceEntry.source, card.id);
		if (!detail) continue;

		const normalized = normalizeIndividualDetailPayload(detail, card.id) as Record<string, any>;
		const extracted = extractCardSummaryFields(normalized, card.id, sourceEntry.source);

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

	if (!summary.name) {
		const logName = getCrdLogNameMap().get(`${card.entity}:${card.id}`);
		if (logName) summary.name = logName;
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

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

function randomBetween(minMs: number, maxMs: number) {
	const floor = Math.max(0, Math.floor(minMs));
	const ceil = Math.max(floor, Math.floor(maxMs));
	return floor + Math.floor(Math.random() * (ceil - floor + 1));
}

function isTooManyRequestsError(error: unknown) {
	const status = Number((error as any)?.status || (error as any)?.response?.status || 0);
	return status === 429 || status === 403 || status === 401 || /\b429\b/.test(String((error as any)?.message || error || ''));
}

function createUpstreamCooldownMs() {
	return randomBetween(DASHBOARD_429_COOLDOWN_MIN_MS, DASHBOARD_429_COOLDOWN_MAX_MS);
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

	const searchQueries = queries.filter((query) => !/^\d{1,10}$/.test(query));
	const searchBundles = await mapWithConcurrency(searchQueries, DASHBOARD_QUERY_RESOLVE_CONCURRENCY, (query) => resolveQuerySearchBundle(query));
	const searchBundleMap = new Map(searchBundles.map((bundle) => [bundle.query, bundle]));

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
			const bundle = searchBundleMap.get(query);
			if (!bundle || bundle.error) {
				resolution.push({ query, crdCount: 0, crds: [] });
				continue;
			}

			const crdsForQuery = new Set<string>();
			const individualKeys = ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id'];
			const firmKeys = ['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];

			for (const item of collectSearchItems(bundle.finraIndividual)) {
				const id = extractNumericId(item, individualKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'finra', type: 'individual' });
			}
			for (const item of collectSearchItems(bundle.finraFirm)) {
				const id = extractNumericId(item, firmKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'finra', type: 'firm' });
			}
			for (const item of collectSearchItems(bundle.secIndividual)) {
				const id = extractNumericId(item, individualKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'sec', type: 'individual' });
			}
			for (const item of collectSearchItems(bundle.secFirm)) {
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

const DASHBOARD_INVENTORY_COUNTER_KEY = 'dashboard:inventory-counter';

async function getInventoryCounterFromRedis() {
	const redis = ensureRedisClient();
	if (!redis) return 0;
	const value = await redis.get(DASHBOARD_INVENTORY_COUNTER_KEY).catch(() => null);
	const numericValue = Number(value ?? 0);
	return Number.isFinite(numericValue) ? numericValue : 0;
}

async function incrementInventoryCounterInRedis(amount = 1) {
	const redis = ensureRedisClient();
	if (!redis) return { ok: false, count: 0 };
	const safeAmount = Math.max(1, Math.floor(Number(amount) || 1));
	const nextCount = await redis.incrby(DASHBOARD_INVENTORY_COUNTER_KEY, safeAmount).catch(() => null);
	const numericCount = Number(nextCount ?? 0);
	return { ok: true, count: Number.isFinite(numericCount) ? numericCount : 0 };
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

async function fetchJson(url: string, options: { timeoutMs?: number } = {}) {
	const timeoutMs = Math.max(1_000, Number(options.timeoutMs || DASHBOARD_DETAIL_FETCH_TIMEOUT_MS));
	const response = await fetch(url, {
		headers: {
			'Accept': 'application/json',
		},
		signal: AbortSignal.timeout(timeoutMs),
		next: { revalidate: 0 },
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		console.warn(`fetchJson failed: ${url} -> HTTP ${response.status}`, text.slice(0, 200));
		const error = new Error(`HTTP ${response.status}`) as Error & { status?: number; bodyText?: string };
		error.status = response.status;
		error.bodyText = text;
		throw error;
	}
	return response.json();
}

async function keyExistsInRedis(redis: Redis | null, key: string) {
	if (!redis || !key) return false;
	try {
		const type = await redis.type(key);
		return Boolean(type && type !== 'none');
	} catch {
		return false;
	}
}

async function cacheArtifactExists(paths: string[]) {
	for (const targetPath of paths) {
		if (!targetPath) continue;
		if (await exists(targetPath)) return true;
	}
	return false;
}

async function recordExistsBeforeFetch(redis: Redis | null, entity: 'individual' | 'firm', crd: string) {
	const sourcePairs: Array<{ source: 'finra' | 'sec'; redisKey: string; files: string[] }> = [
		{
			source: 'finra',
			redisKey: entity === 'individual' ? `finra:individual:${crd}` : `finra:firm:${crd}`,
			files: [
				buildLocalCacheFilePath('finra', entity, crd),
				path.join(process.cwd(), 'data', 'raw', 'brokercheck.finra.org', `api.brokercheck.finra.org_search_${entity}_${crd}.json`),
			],
		},
		{
			source: 'sec',
			redisKey: entity === 'individual' ? `sec:individual:${crd}` : `sec:firm:${crd}`,
			files: [buildLocalCacheFilePath('sec', entity, crd), path.join(process.cwd(), 'data', 'raw', 'adviserinfo.sec.gov', `api.adviserinfo.sec.gov_search_${entity}_${crd}.json`)],
		},
	];

	for (const pair of sourcePairs) {
		if (await cacheArtifactExists(pair.files)) return true;
		if (await keyExistsInRedis(redis, pair.redisKey)) return true;
	}

	return false;
}

export function summarizeFetchResults(results: FetchResultItem[]) {
	const successCount = results.filter((item) => item.status === 'ok').length;
	const skippedCount = results.filter((item) => item.status === 'skipped').length;
	const errorCount = results.filter((item) => item.status === 'error').length;
	const uniqueCrds = new Set(results.map((item) => item.crd));
	const newSourceCount = results.filter((item) => item.newSourceSaved === true).length;
	const newRecordItems = results.filter((item) => item.newRecordSaved === true);
	const newRecordKeys = new Set(newRecordItems.map((item) => String(item.cardKey || `${item.type}:${item.crd}`)));
	const newPeopleCount = new Set(newRecordItems.filter((item) => item.type === 'individual').map((item) => item.crd)).size;
	const newFirmCount = new Set(newRecordItems.filter((item) => item.type === 'firm').map((item) => item.crd)).size;

	return {
		crdCount: uniqueCrds.size,
		requests: results.length,
		successCount,
		skippedCount,
		errorCount,
		newSourceCount,
		newRecordCount: newRecordKeys.size,
		newPeopleCount,
		newFirmCount,
	};
}

function splitIntoChunks(value: string, maxChunkChars: number) {
	const chunks: string[] = [];
	for (let index = 0; index < value.length; index += maxChunkChars) {
		chunks.push(value.slice(index, index + maxChunkChars));
	}
	return chunks;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function runWorker() {
		while (true) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) return;
			results[currentIndex] = await worker(items[currentIndex], currentIndex);
		}
	}

	await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, () => runWorker()));
	return results;
}

function buildSkippedFetchResult(
	target: FetchTarget,
	details: Pick<FetchResultItem, 'url' | 'cacheFile' | 'redisKey'> & { cardKey?: string },
	reason: string,
	payload?: unknown,
): FetchResultItem {
	return {
		crd: target.crd,
		source: target.source,
		type: target.type,
		url: details.url,
		cacheFile: details.cacheFile,
		redisKey: details.redisKey,
		cardKey: details.cardKey,
		status: 'skipped',
		redisWrite: `skipped:${reason}`,
		skipReason: reason,
		...(payload !== undefined ? { payload } : {}),
	};
}

export function classifyFetchedPayloadOutcome(payload: unknown, target: FetchTarget): { status: 'ok' | 'skipped' | 'error'; error?: string; skipReason?: string } {
	if (!isValidFetchedPayload(payload)) {
		return { status: 'error', error: 'invalid-payload-shape' };
	}

	if (!fetchedPayloadHasSourceCoverage(payload, target)) {
		return { status: 'skipped', skipReason: 'out-of-scope-source-payload' };
	}

	return { status: 'ok' };
}

type QuerySearchBundle = {
	query: string;
	finraIndividual?: any;
	finraFirm?: any;
	secIndividual?: any;
	secFirm?: any;
	error?: string;
};

async function resolveQuerySearchBundle(query: string): Promise<QuerySearchBundle> {
	const encoded = encodeURIComponent(query);
	try {
		const fetchWithPacingAndRetry = async (url: string) => {
			let attempt = 0;
			const maxRetries = 2;
			while (attempt <= maxRetries) {
				attempt++;
				await sleep(randomBetween(2000, DASHBOARD_DETAIL_FETCH_JITTER_MS + 2000));
				try {
					return await fetchJson(url, { timeoutMs: DASHBOARD_SEARCH_FETCH_TIMEOUT_MS });
				} catch (error: any) {
					if (isTooManyRequestsError(error)) {
						const retryAfterHeader = error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'];
						const retryAfter = Number.isFinite(Number(retryAfterHeader)) && Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : null;
						const cooldownMs = retryAfter || randomBetween(2 * 60 * 1000, 4 * 60 * 1000); 
						console.warn(`[resolve-query] 429 from ${url}; pausing for ${(cooldownMs / 60000).toFixed(2)} minutes`);
						await sleep(cooldownMs);
						if (attempt > maxRetries) throw error;
					} else {
						throw error;
					}
				}
			}
		};

		const finraIndividual = await fetchWithPacingAndRetry(`https://api.brokercheck.finra.org/search/individual?query=${encoded}&hl=true&includePrevious=true&nrows=50&start=0&wt=json`);
		const finraFirm = await fetchWithPacingAndRetry(`https://api.brokercheck.finra.org/search/firm?query=${encoded}&hl=true&nrows=12&start=0&wt=json`);
		const secIndividual = await fetchWithPacingAndRetry(`https://api.adviserinfo.sec.gov/search/individual?query=${encoded}&hl=true&includePrevious=true&nrows=50&start=0&wt=json`);
		const secFirm = await fetchWithPacingAndRetry(`https://api.adviserinfo.sec.gov/search/firm?query=${encoded}&hl=true&nrows=12&start=0&wt=json`);

		return {
			query,
			finraIndividual,
			finraFirm,
			secIndividual,
			secFirm,
		};
	} catch (error: any) {
		console.error(`resolveQuerySearchBundle failed for "${query}":`, error.message);
		return {
			query,
			error: error?.message || String(error),
		};
	}
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
	const count = Math.max(500, Math.min(5_000, Math.floor(limit / 8) || 2_000));
	const maxLoops = Math.max(20, Math.ceil(limit / Math.max(1, count)) + 8);

	do {
		const [nextCursor, batch] = await redis.scan(cursor, {
			match: pattern,
			count,
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

async function collectNativeRedisRecordKeys(redis: Redis, forceRefresh = false) {
	const now = Date.now();
	if (!forceRefresh && nativeRedisKeyCache && now - nativeRedisKeyCache.fetchedAt <= DASHBOARD_NATIVE_REDIS_KEY_CACHE_MS) {
		return nativeRedisKeyCache.keys;
	}

	const patterns = ['finra:individual:*', 'sec:individual:*', 'finra:firm:*', 'sec:firm:*'];
	const scannedGroups = await Promise.all(patterns.map((pattern) => scanKeys(redis, pattern, DASHBOARD_REDIS_SCAN_CARD_LIMIT_PER_PATTERN)));
	const dedupedKeys = new Set<string>();

	for (const scannedKeys of scannedGroups) {
		for (const key of scannedKeys) {
			const parsed = parseCacheKey(key);
			if (!parsed) continue;
			dedupedKeys.add(`${parsed.source}:${parsed.entity}:${parsed.id}`);
		}
	}

	const keys = Array.from(dedupedKeys.values());
	nativeRedisKeyCache = { keys, fetchedAt: now };
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

function applyCardFilter<T extends { id: string; name?: string; entity?: string }>(cards: T[], filterTokens: string[]) {
	if (!filterTokens.length) return cards;
	const lower = filterTokens.map((t) => t.toLowerCase());
	const exact = cards.filter((card) => filterTokens.some((token) => card.id === token));
	const partial = cards.filter(
		(card) =>
			!filterTokens.some((token) => card.id === token) &&
			lower.some((token) => card.id.includes(token) || (card.name || '').toLowerCase().includes(token) || (card.entity || '').toLowerCase().startsWith(token)),
	);
	return [...exact, ...partial];
}

export function shouldUseLocalFallback(cardCount: number, hasFilterTokens: boolean) {
	return false;
}

function countInventoryTotalsFromCrdLog(): InventoryTotals {
	const log = loadCrdLog();
	return {
		people: log.individuals.length,
		firms: log.firms.length,
		unique: log.individuals.length + log.firms.length,
		source: 'local-raw',
	};
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
		inventoryTotals: countInventoryTotalsFromCrdLog(),
		sourceMode: 'local-fallback' as const,
		persistenceNotice: 'Durable Redis cache is unavailable in this environment. Showing local fallback files only; newly fetched cards may not persist between instances.',
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
	const bundleCounts: Array<{ bundleName: string; recordCount: number }> = [];
	let totalCards = 0;
	let totalCacheKeys = 0;

	for (const bundleName of bundleNames) {
		const bundleKey = `primed:bundle:${bundleName}`;
		const metaRaw = await redis.get(`${bundleKey}:meta`).catch(() => null);
		if (!metaRaw) continue;
		const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
		const recordCount = Number(meta?.recordCount || 0);
		if (recordCount > 0) {
			bundleCounts.push({ bundleName, recordCount });
			totalCards += recordCount;
			totalCacheKeys += recordCount;
			const [source, entity] = bundleName.split('-') as ['finra' | 'sec', 'individual' | 'firm'];
			upsertCardIndexEntry(cardIndex, { source, entity, id: `__${bundleName}__` });
		}
	}

	if (totalCards === 0) return null;

	const inventoryTotals = buildPrimedBundleInventoryTotals(bundleCounts);
	primedBundleCardIndexCache = cardIndex;
	primedBundleTotalsCache = { totalCards, totalCacheKeys, ...inventoryTotals };
	return primedBundleTotalsCache;
}

async function listCacheCards(maxCards = 200, crdFilter = '') {
	const redis = ensureRedisClient();
	if (!redis) {
		return listLocalNewestCards(maxCards, crdFilter);
	}

	const filterTokens = parseFilterTokens(crdFilter);
	const nameMap = getCrdLogNameMap();
	const nativeKeys = await collectNativeRedisRecordKeys(redis);
	const cards = buildCacheCardsFromRedisKeys(nativeKeys, nameMap);
	const inventoryTotals = collectInventoryTotalsFromCacheKeys(nativeKeys, 'redis');
	const cachedDedupedTotals = await readPrimedBundleTotals(redis, true).catch(() => null);
	const rawFallbackTotals = countInventoryTotalsFromCrdLog();
	const effectiveInventoryTotals = resolveDashboardInventoryTotals(
		inventoryTotals,
		cachedDedupedTotals ?
			{
				people: cachedDedupedTotals.people,
				firms: cachedDedupedTotals.firms,
				unique: cachedDedupedTotals.unique,
				source: 'primed-bundle' as const,
			}
		:	null,
		rawFallbackTotals,
	);

	const fallbackManifestTotals = null;
	if (shouldUseLocalFallback(cards.length, filterTokens.length > 0)) {
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
		return {
			ok: true,
			cards: [],
			totalCards: fallbackManifestTotals?.totalCards ?? 0,
			totalCacheKeys: fallbackManifestTotals?.totalCacheKeys ?? nativeKeys.length,
			filteredTotalCards: 0,
			inventoryTotals: effectiveInventoryTotals,
			sourceMode: 'redis' as const,
			persistenceNotice:
				cachedDedupedTotals ?
					'Redis primed bundles are present, but native record keys are empty. Backfill the primed bundles into native finra:/sec: record keys to populate dashboard cards.'
				:	null,
		};
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
		totalCards: fallbackManifestTotals?.totalCards ?? cards.length,
		totalCacheKeys: fallbackManifestTotals?.totalCacheKeys ?? nativeKeys.length,
		filteredTotalCards: filteredCards.length,
		inventoryTotals: effectiveInventoryTotals,
		sourceMode: 'redis',
		persistenceNotice: null,
	};
}

async function listNewCrds() {
	const redis = ensureRedisClient();
	if (!redis) {
		return { ok: true, newCrds: [], isToday: false, lastChecked: null };
	}
	const nativeKeys = await collectNativeRedisRecordKeys(redis);
	const cards = buildCacheCardsFromRedisKeys(nativeKeys, getCrdLogNameMap());
	const cardMap = new Map(cards.map((card) => [`${card.entity}:${card.id}`, card]));
	const recentSeeds = await getRecentSeedsFromStore().catch(() => ({ individualIds: [], firmIds: [], updatedAt: new Date(0).toISOString() }));
	const recentTargets = [...recentSeeds.individualIds.map((id) => ({ entity: 'individual' as const, id })), ...recentSeeds.firmIds.map((id) => ({ entity: 'firm' as const, id }))]
		.sort((left, right) => Number(right.id) - Number(left.id))
		.slice(0, 20);

	const fallbackCards = cards
		.slice()
		.sort((left, right) => Number(right.id) - Number(left.id))
		.slice(0, 20);
	const latestCards = recentTargets.length > 0 ? recentTargets.map(({ entity, id }) => cardMap.get(`${entity}:${id}`) || { id, entity, files: 0, sources: [] }) : fallbackCards;
	const updatedAt = Date.parse(String(recentSeeds.updatedAt || '')) || Date.now();
	const now = Date.now();

	const formatted = await Promise.all(
		latestCards.map(async (card) => {
			// Skip semantic normalization for dashboard to avoid Redis lookups
			const normalized = normalizeCardForDisplay(card);
			const updatedDate = new Date(updatedAt);
			const daysAgo = Math.max(0, Math.floor((now - updatedAt) / (1000 * 60 * 60 * 24)));
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
		isToday: updatedAt >= now - 24 * 60 * 60 * 1000,
		lastChecked: new Date().toISOString(),
		detectedCount: cards.length,
		shownCount: latestCards.length,
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

async function fetchCrdsToCacheAndRedis(initialTargets: FetchTarget[], options: { includePayload?: boolean } = {}) {
	const { includePayload = false } = options;
	const mainAppPublishQueue: Array<Pick<FetchResultItem, 'crd' | 'type' | 'status' | 'payload'> & { source: 'finra' | 'sec' }> = [];
	const nationalRoot = path.join(process.cwd(), 'data', 'national');
	const rawRoot = path.join(process.cwd(), 'data', 'raw');
	const redis = ensureRedisClient();
	const recordExistenceCache = new Map<string, Promise<boolean>>();

	const allResults: FetchResultItem[] = [];
	const processedKeys = new Set<string>();
	let upstreamCooldownUntil = 0;
	const targetQueue: FetchTarget[] = [...initialTargets];
	let depth = 0;
	const MAX_DEPTH = 3; // "and so on" but with a safety break

	while (targetQueue.length > 0 && depth < MAX_DEPTH) {
		const currentTargets = [...targetQueue];
		targetQueue.length = 0;
		depth += 1;

		for (const target of currentTargets) {
			const crd = target.crd;
			const key = `${target.source}:${target.type}:${crd}`;
			if (processedKeys.has(key)) continue;
			processedKeys.add(key);

			const now = Date.now();
			if (now < upstreamCooldownUntil) {
				const waitMs = upstreamCooldownUntil - now;
				console.log(`[fetch-crds] Sequential pause for 429 cooldown: ${(waitMs / 60000).toFixed(2)} minutes`);
				await sleep(waitMs);
			}

			// Random jittered delay between EVERY request as requested
			await sleep(randomBetween(DASHBOARD_DETAIL_FETCH_DELAY_MS, DASHBOARD_DETAIL_FETCH_DELAY_MS + DASHBOARD_DETAIL_FETCH_JITTER_MS));

			const isFinra = target.source === 'finra';
			const isIndividual = target.type === 'individual';
			const cardKey = `${target.type}:${crd}`;
			const url =
				isFinra && isIndividual ? `https://api.brokercheck.finra.org/search/individual/${crd}?hl=true&includePrevious=true&wt=json`
				: isFinra && !isIndividual ? `https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&wt=json`
				: !isFinra && isIndividual ? `https://api.adviserinfo.sec.gov/search/individual/${crd}?hl=true&includePrevious=true&wt=json`
				: `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`;
			
			const cacheFileName = `api.${isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov'}_search_${target.type}_${crd}.json`;
			const cacheDir = isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
			const redisKey = target.type === 'individual' ? `${target.source}:individual:${crd}` : `${target.source}:firm:${crd}`;
			
			const nationalFile = path.join(nationalRoot, cacheDir, cacheFileName);
			const rawFile = path.join(rawRoot, cacheDir, cacheFileName);

			try {
				const sourceExistedBefore = (await cacheArtifactExists([nationalFile, rawFile])) || (await keyExistsInRedis(redis, redisKey));
				const recordExistedBeforePromise = recordExistenceCache.get(cardKey) || (async () => recordExistsBeforeFetch(redis, target.type, crd))();
				recordExistenceCache.set(cardKey, recordExistedBeforePromise);
				const recordExistedBefore = await recordExistedBeforePromise;

				let payload: any;
				try {
					payload = await fetchJson(url, { timeoutMs: DASHBOARD_DETAIL_FETCH_TIMEOUT_MS });
				} catch (error: any) {
					if (isTooManyRequestsError(error)) {
						const retryAfterHeader = error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'];
						const retryAfter = Number.isFinite(Number(retryAfterHeader)) && Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : null;
						
						// Respect retryAfter if present, otherwise 2-4 minutes like the reference app
						const cooldownMs = retryAfter || randomBetween(2 * 60 * 1000, 4 * 60 * 1000); 
						upstreamCooldownUntil = Date.now() + cooldownMs;
						console.warn(`[fetch-crds] 429 from ${url}; pausing for ${(cooldownMs / 60000).toFixed(2)} minutes`);
						await sleep(cooldownMs);
						payload = await fetchJson(url, { timeoutMs: DASHBOARD_DETAIL_FETCH_TIMEOUT_MS });
					} else {
						throw error;
					}
				}

				const outcome = classifyFetchedPayloadOutcome(payload, target);
				if (outcome.status === 'error') {
					allResults.push({
						crd, source: target.source, type: target.type, url, cacheFile: nationalFile, redisKey, cardKey,
						status: 'error', redisWrite: 'not-attempted', error: outcome.error || 'invalid-payload-shape',
					});
					continue;
				}

				if (outcome.status === 'skipped') {
					allResults.push(buildSkippedFetchResult(target, { url, cacheFile: nationalFile, redisKey, cardKey }, outcome.skipReason || 'out-of-scope-source-payload', includePayload ? payload : undefined));
					continue;
				}

				// Success: Save and Discover
				try {
					await Promise.all([writeJsonFile(nationalFile, payload), writeJsonFile(rawFile, payload)]);
				} catch (fileErr: any) {
					console.warn(`[fetch-crds] Skipping local file write (expected in Vercel): ${fileErr.message}`);
				}
				await setStringIfValid(redisKey, JSON.stringify(payload), 0);

				const newSourceSaved = !sourceExistedBefore;
				const newRecordSaved = !recordExistedBefore;

				mainAppPublishQueue.push({ crd, source: target.source, type: target.type, status: 'ok', payload });

				const fetchResult: FetchResultItem = {
					crd, source: target.source, type: target.type, url, cacheFile: nationalFile, redisKey, cardKey,
					status: 'ok', redisWrite: 'written', newSourceSaved, newRecordSaved,
				};
				if (includePayload) fetchResult.payload = payload;
				allResults.push(fetchResult);

				// Discovery logic: find more CRDs to fetch sequentially
				const artifacts = buildMainAppGraphArtifactsFromFetchedPayload(payload, target);
				for (const node of artifacts.nodes) {
					const discoveredCrd = node.crd || node.firmId;
					if (!discoveredCrd || discoveredCrd === crd) continue;
					const discoveredType = node.group === 'firm' ? 'firm' : 'individual';
					targetQueue.push({ crd: discoveredCrd, source: 'finra', type: discoveredType });
					targetQueue.push({ crd: discoveredCrd, source: 'sec', type: discoveredType });
				}

			} catch (error: any) {
				allResults.push({
					crd, source: target.source, type: target.type, url, cacheFile: nationalFile, redisKey, cardKey,
					status: 'error', redisWrite: 'not-attempted', error: error?.message || String(error),
				});
			}
		}
	}

	const mainAppSync = await publishFetchedRecordsToMainApp(mainAppPublishQueue).catch(() => ({
		rememberedSeeds: 0, nodesAdded: 0, nodesUpdated: 0, linksAdded: 0,
	}));

	return {
		summary: summarizeFetchResults(allResults),
		mainAppSync,
		results: allResults,
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
	if (!action || !['fetch-crds', 'sync-and-deploy-primed', 'list-cache-cards', 'list-new-crds', 'get-inventory-counter', 'increment-inventory-counter'].includes(action)) {
		return NextResponse.json({ ok: false, error: 'invalid-action' }, { status: 400 });
	}

	try {
		if (action === 'get-inventory-counter') {
			return NextResponse.json({ ok: true, action, count: await getInventoryCounterFromRedis(), at: new Date().toISOString() });
		}

		if (action === 'increment-inventory-counter') {
			const amount = Math.max(1, Number(body.amount || 1));
			return NextResponse.json({ ok: true, action, ...(await incrementInventoryCounterInRedis(amount)), at: new Date().toISOString() });
		}

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
				inventoryTotals: listed.inventoryTotals,
				sourceMode: listed.sourceMode,
				persistenceNotice: (listed as any).persistenceNotice ?? null,
				at: new Date().toISOString(),
			});
		}

		if (action === 'fetch-crds') {
			const maxCrds = Number(body.maxCrds || 30);
			const queries = parseQueries(body.queries ?? body.crds, maxCrds);
			const providedCrds = parseCrds(body.crds, maxCrds);

			console.log(`[fetch-crds] Processing ${queries.length} queries and ${providedCrds.length} direct CRDs`);

			const resolvedFromQueries = await resolveCrdsFromQueries(queries, maxCrds);

			if (resolvedFromQueries.resolution.every((r) => r.crdCount === 0) && providedCrds.length === 0 && queries.length > 0) {
				console.warn('[fetch-crds] No CRDs resolved from queries:', queries);
			}

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
				const hasErrors = resolvedFromQueries.resolution.some((r) => (r as any).error);
				return NextResponse.json(
					{
						ok: false,
						error: hasErrors ? 'search-failed' : 'no-valid-crds',
						queries,
						resolvedQueryCount: resolvedFromQueries.resolution.filter((entry) => entry.crdCount > 0).length,
						resolution: resolvedFromQueries.resolution,
					},
					{ status: hasErrors ? 502 : 400 },
				);
			}

			console.log(`[fetch-crds] Fetching ${targets.length} targets...`);
			const fetched = await fetchCrdsToCacheAndRedis(targets, { includePayload: Boolean(body.includePayload) });
			resetDashboardInventoryCaches();
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
		resetDashboardInventoryCaches();

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
