import axios from 'axios';
import { Redis } from '@upstash/redis';
import { saveGraph, getFullGraph } from '@/lib/graphStore';
import { getSeedBankFromStore } from '@/lib/graphStore';
import { DEFAULT_HEADERS } from '@/lib/requestConstants';

const STATE_KEY = 'finra:cron:external-validity:state';
const MONITOR_KEY = 'finra:redis-monitor';
const INDIVIDUAL_QUERY = new URLSearchParams({ hl: 'true', includePrevious: 'true', wt: 'json' }).toString();
const FIRM_QUERY = new URLSearchParams({ hl: 'true', wt: 'json' }).toString();

const DEFAULT_DISCOVERY_BATCH = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_DISCOVERY_BATCH || 3));
const DEFAULT_UPDATE_BATCH = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_UPDATE_BATCH || 3));
const DEFAULT_FAILBACK_MINUTES = [6, 11] as const;

type CronState = {
	backoffUntil: number;
	discovery: {
		individualNext: number;
		firmNext: number;
	};
	updateIndex: {
		individual: number;
		firm: number;
	};
	updatedAt: string;
	lastRunAt: string | null;
};

type RunSummary = {
	processed: number;
	discovered: number;
	updated: number;
	skippedNoData: number;
	backoffUntil: number;
	reason?: string;
	state: CronState;
};

type DetailPayload = Record<string, any> | null;

function normalizeId(value: unknown) {
	return String(value || '')
		.trim()
		.replace(/^person[:_]/i, '')
		.replace(/^firm[:_]/i, '');
}

function isNumericId(value: unknown) {
	return /^\d+$/.test(normalizeId(value));
}

function numericSortDesc(left: string, right: string) {
	return Number(right) - Number(left);
}

function uniqueSortedNumericIds(values: unknown[]) {
	return Array.from(new Set(values.map(normalizeId).filter(isNumericId))).sort(numericSortDesc);
}

function maxNumericId(values: string[]) {
	if (!values.length) return 0;
	return Math.max(...values.map((v) => Number(v)).filter((n) => Number.isFinite(n)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergePreferPatch(base: unknown, patch: unknown): unknown {
	if (patch == null || patch === '') return base;
	if (base == null || base === '') return patch;
	if (Array.isArray(base) && Array.isArray(patch)) {
		if (!patch.length) return base;
		if (!base.length) return patch;
		const seen = new Set(base.map((item) => JSON.stringify(item)));
		return [
			...base,
			...patch.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		];
	}
	if (isPlainObject(base) && isPlainObject(patch)) {
		const merged: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(patch)) {
			merged[key] = key in merged ? mergePreferPatch(merged[key], value) : value;
		}
		return merged;
	}
	return patch;
}

function parseDetailPayload(data: any, contentKey = 'content') {
	if (!data) return null;
	if (data?.hits?.hits?.length) {
		const raw = data.hits.hits[0]?._source?.[contentKey];
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
		}
	}

	const raw = data?.[contentKey];
	if (raw != null) {
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
		}
	}

	if (isPlainObject(data)) {
		const looksLikeDetail =
			data.basicInformation ||
			data.individualId ||
			data.firstName ||
			data.lastName ||
			data.bcScope ||
			data.iaScope ||
			data.firmStatus ||
			data.disclosures ||
			data.currentEmployments ||
			data.previousEmployments ||
			data.directOwners;
		if (looksLikeDetail) return data;
	}

	return null;
}

function getAuthHeaders() {
	return { Accept: 'application/json', ...DEFAULT_HEADERS };
}

async function fetchUpstreamJson(url: string) {
	const response = await axios.get(url, {
		headers: getAuthHeaders(),
		timeout: 15000,
		validateStatus: () => true,
	});
	if (response.status === 429) {
		const error = new Error(`HTTP 429 for ${url}`);
		(error as any).status = 429;
		throw error;
	}
	if (response.status === 404) return null;
	if (response.status >= 400) {
		const error = new Error(`HTTP ${response.status} for ${url}`);
		(error as any).status = response.status;
		throw error;
	}
	return response.data;
}

async function fetchRecord(kind: 'individual' | 'firm', id: string) {
	const normalized = normalizeId(id);
	if (!isNumericId(normalized)) return { finra: null, sec: null };
	const finraUrl =
		kind === 'individual' ?
			`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(normalized)}?${INDIVIDUAL_QUERY}`
		:	`https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(normalized)}?${FIRM_QUERY}`;
	const secUrl =
		kind === 'individual' ?
			`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(normalized)}?wt=json`
		:	`https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(normalized)}?wt=json`;
	const [finra, sec] = await Promise.all([fetchUpstreamJson(finraUrl), fetchUpstreamJson(secUrl)]);
	return {
		finra: parseDetailPayload(finra, 'content'),
		sec: parseDetailPayload(sec, 'iacontent'),
	};
}

function getDisplayName(kind: 'individual' | 'firm', detail: any, id: string) {
	const basic = detail?.basicInformation || {};
	if (kind === 'individual') {
		return [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ') || detail?.name || `CRD ${id}`;
	}
	return basic.firmName || detail?.firmName || detail?.name || `Firm ${id}`;
}

function buildRecordNode(kind: 'individual' | 'firm', id: string, finra: any, sec: any) {
	const merged =
		finra ?
			sec ? mergePreferPatch(finra, sec)
			:	finra
		:	sec;
	if (!merged) return null;
	const basic = merged.basicInformation || {};
	const nodeId = kind === 'individual' ? `person:${normalizeId(id)}` : `firm:${normalizeId(id)}`;
	const node: any = {
		id: nodeId,
		label: getDisplayName(kind, merged, normalizeId(id)),
		group: kind === 'individual' ? 'individual' : 'firm',
		_source: 'external-validity-cron',
		lastCheckedAt: new Date().toISOString(),
		hasFinraData: Boolean(finra),
		hasSecData: Boolean(sec),
		basicInformation: merged.basicInformation || basic,
		crd: kind === 'individual' ? normalizeId(id) : undefined,
		firmId: kind === 'firm' ? normalizeId(id) : undefined,
	};

	if (kind === 'individual') {
		node.bcScope = merged.bcScope ?? basic.bcScope ?? null;
		node.iaScope = merged.iaScope ?? basic.iaScope ?? null;
		node.disclosures = merged.disclosures ?? null;
		node.currentEmployments =
			Array.isArray(merged.currentEmployments) ? merged.currentEmployments
			: Array.isArray(merged.ind_current_employments) ? merged.ind_current_employments
			: [];
		node.currentIAEmployments =
			Array.isArray(merged.currentIAEmployments) ? merged.currentIAEmployments
			: Array.isArray(merged.ind_ia_current_employments) ? merged.ind_ia_current_employments
			: [];
	} else {
		node.bcScope = merged.bcScope ?? basic.bcScope ?? null;
		node.iaScope = merged.iaScope ?? basic.iaScope ?? null;
		node.firmStatus = merged.firmStatus ?? basic.firmStatus ?? null;
		node.firmStatusDate = merged.firmStatusDate ?? basic.firmStatusDate ?? null;
		node.directOwners = Array.isArray(merged.directOwners) ? merged.directOwners : [];
		node.disclosures = merged.disclosures ?? [];
	}

	return node;
}

function addEmploymentLinks(node: any, merged: any, existingNodes: Map<string, any>) {
	const links: any[] = [];
	const employments = [
		...(Array.isArray(merged?.currentEmployments) ? merged.currentEmployments : []),
		...(Array.isArray(merged?.ind_current_employments) ? merged.ind_current_employments : []),
		...(Array.isArray(merged?.currentIAEmployments) ? merged.currentIAEmployments : []),
		...(Array.isArray(merged?.ind_ia_current_employments) ? merged.ind_ia_current_employments : []),
	];

	for (const employment of employments) {
		const firmId = normalizeId(employment?.firm_id || employment?.firmId || employment?.firm_source_id || '');
		if (!isNumericId(firmId)) continue;
		const firmNodeId = `firm:${firmId}`;
		if (!existingNodes.has(firmNodeId)) {
			existingNodes.set(firmNodeId, {
				id: firmNodeId,
				label: employment?.firm_name || employment?.firmName || `Firm ${firmId}`,
				group: 'firm',
				firmId,
				_source: 'external-validity-cron',
				stub: true,
			});
		}
		links.push({ source: node.id, target: firmNodeId, relationship: 'employed_by', isCurrent: true });
	}

	return links;
}

function mergeIntoGraph(graph: any, node: any, links: any[]) {
	const nodeMap = new Map<string, any>();
	for (const existing of Array.isArray(graph?.nodes) ? graph.nodes : []) {
		const id = String(existing?.id || '').trim();
		if (id) nodeMap.set(id, existing);
	}

	const current = nodeMap.get(node.id);
	if (current) {
		nodeMap.set(node.id, mergePreferPatch(current, node) as any);
	} else {
		nodeMap.set(node.id, node);
	}

	const extraNodes = (links as any)._extraNodes || [];
	for (const extraNode of extraNodes) {
		if (!nodeMap.has(extraNode.id)) nodeMap.set(extraNode.id, extraNode);
		else nodeMap.set(extraNode.id, mergePreferPatch(nodeMap.get(extraNode.id), extraNode) as any);
	}

	const mergedNodes = Array.from(nodeMap.values());
	const linkKey = (link: any) => `${String(link?.source?.id ?? link?.source ?? '')}|${String(link?.target?.id ?? link?.target ?? '')}|${String(link?.relationship || '')}`;
	const existingLinks = new Set((Array.isArray(graph?.links) ? graph.links : []).map(linkKey));
	const mergedLinks = [...(Array.isArray(graph?.links) ? graph.links : [])];
	for (const link of links as any[]) {
		if (existingLinks.has(linkKey(link))) continue;
		mergedLinks.push(link);
	}

	const meta = {
		...(graph?.meta || {}),
		generated: new Date().toISOString(),
		externalValidityCheckedAt: new Date().toISOString(),
	};

	return { nodes: mergedNodes, links: mergedLinks, meta };
}

function createDefaultState(maxIndividual: number, maxFirm: number): CronState {
	return {
		backoffUntil: 0,
		discovery: {
			individualNext: maxIndividual + 1,
			firmNext: maxFirm + 1,
		},
		updateIndex: {
			individual: maxIndividual,
			firm: maxFirm,
		},
		updatedAt: new Date().toISOString(),
		lastRunAt: null,
	};
}

function normalizeState(raw: unknown, maxIndividual: number, maxFirm: number): CronState {
	const fallback = createDefaultState(maxIndividual, maxFirm);
	if (!raw || typeof raw !== 'object') return fallback;
	const candidate = raw as Partial<CronState>;
	return {
		backoffUntil: Math.max(0, Number(candidate.backoffUntil || 0)),
		discovery: {
			individualNext: Math.max(maxIndividual + 1, Number(candidate.discovery?.individualNext || fallback.discovery.individualNext)),
			firmNext: Math.max(maxFirm + 1, Number(candidate.discovery?.firmNext || fallback.discovery.firmNext)),
		},
		updateIndex: {
			individual: (() => {
				const raw = Number(candidate.updateIndex?.individual);
				if (!Number.isFinite(raw) || raw <= 0) return fallback.updateIndex.individual;
				return Math.max(0, Math.min(maxIndividual || 0, raw));
			})(),
			firm: (() => {
				const raw = Number(candidate.updateIndex?.firm);
				if (!Number.isFinite(raw) || raw <= 0) return fallback.updateIndex.firm;
				return Math.max(0, Math.min(maxFirm || 0, raw));
			})(),
		},
		updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : new Date().toISOString(),
		lastRunAt: typeof candidate.lastRunAt === 'string' ? candidate.lastRunAt : null,
	};
}

function getRedisClient() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	return url && token ? new Redis({ url, token }) : null;
}

function chooseBackoffUntil(now: number) {
	const minutes = DEFAULT_FAILBACK_MINUTES[0] + Math.floor(Math.random() * (DEFAULT_FAILBACK_MINUTES[1] - DEFAULT_FAILBACK_MINUTES[0] + 1));
	return now + minutes * 60 * 1000;
}

async function storeState(redis: Redis, state: CronState) {
	await redis.set(STATE_KEY, JSON.stringify(state), { ex: 60 * 60 * 24 * 30 });
}

async function loadState(redis: Redis, maxIndividual: number, maxFirm: number): Promise<CronState> {
	try {
		const raw = await redis.get<string>(STATE_KEY);
		if (!raw) return createDefaultState(maxIndividual, maxFirm);
		return normalizeState(typeof raw === 'string' ? JSON.parse(raw) : raw, maxIndividual, maxFirm);
	} catch {
		return createDefaultState(maxIndividual, maxFirm);
	}
}

function buildDiscoveryCandidates(nextValue: number, batchSize: number) {
	return Array.from({ length: batchSize }, (_, index) => String(nextValue + index));
}

function buildUpdateCandidates(idsDesc: string[], cursor: number, batchSize: number) {
	if (!idsDesc.length) return [] as string[];
	const threshold = Math.max(0, cursor);
	return idsDesc.filter((id) => Number(id) <= threshold).slice(0, batchSize);
}

function nextThreshold(ids: string[], picked: number) {
	if (!picked || !ids.length) return 0;
	const selected = ids.slice(0, picked);
	const lowestSelected = selected.length ? Math.min(...selected.map((id) => Number(id)).filter((n) => Number.isFinite(n))) : 0;
	return lowestSelected > 0 ? lowestSelected - 1 : 0;
}

async function processCandidate(
	redis: Redis,
	graph: any,
	kind: 'individual' | 'firm',
	id: string,
): Promise<{ found: boolean; discovered: boolean; updated: boolean; 429: boolean }> {
	const { finra, sec } = await fetchRecord(kind, id);
	if (!finra && !sec) return { found: false, discovered: false, updated: false, 429: false };

	const node = buildRecordNode(kind, id, finra, sec);
	if (!node) return { found: false, discovered: false, updated: false, 429: false };

	const linksAccumulator: any[] & { _extraNodes?: any[] } = [] as any;
	const tempNodes = new Map<string, any>();
	const extraLinks = addEmploymentLinks(node, node, tempNodes);
	linksAccumulator.push(...extraLinks);
	linksAccumulator._extraNodes = Array.from(tempNodes.values());

	const mergedGraph = mergeIntoGraph(graph, node, linksAccumulator);
	await saveGraph(mergedGraph);

	// refresh direct cache keys so the app reads the newest payloads on the next lookup
	try {
		const searchParams = kind === 'individual' ? INDIVIDUAL_QUERY : FIRM_QUERY;
		await redis.set(`${kind === 'individual' ? 'finra:individual' : 'finra:firm'}:${normalizeId(id)}:${searchParams}`, JSON.stringify(finra || sec), { ex: 60 * 60 * 24 });
		await redis.set(
			`${kind === 'individual' ? 'sec:individual' : 'sec:firm'}:${normalizeId(id)}:${kind === 'individual' ? INDIVIDUAL_QUERY : FIRM_QUERY}`,
			JSON.stringify(sec || finra),
			{ ex: 60 * 60 * 24 },
		);
	} catch {
		// best effort cache refresh only
	}

	return { found: true, discovered: true, updated: true, 429: false };
}

export async function runExternalValidityCron() {
	const redis = getRedisClient();
	if (!redis) {
		return { ok: false, error: 'Missing Upstash Redis configuration', processed: 0, discovered: 0, updated: 0, skippedNoData: 0 };
	}

	const graph = await getFullGraph();
	const seedBank = await getSeedBankFromStore();
	const individualIds = uniqueSortedNumericIds(seedBank?.individualIds || []);
	const firmIds = uniqueSortedNumericIds(seedBank?.firmIds || []);
	const maxIndividual = maxNumericId(individualIds);
	const maxFirm = maxNumericId(firmIds);
	const state = await loadState(redis, maxIndividual, maxFirm);
	const now = Date.now();
	if (state.backoffUntil && now < state.backoffUntil) {
		return { ok: true, skipped: true, reason: 'backoff', resumeAt: state.backoffUntil, processed: 0, discovered: 0, updated: 0, skippedNoData: 0, state };
	}

	const discoveryBatch = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_DISCOVERY_BATCH || DEFAULT_DISCOVERY_BATCH));
	const updateBatch = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_UPDATE_BATCH || DEFAULT_UPDATE_BATCH));
	let nextState: CronState = {
		...state,
		lastRunAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const summary: RunSummary = {
		processed: 0,
		discovered: 0,
		updated: 0,
		skippedNoData: 0,
		backoffUntil: 0,
		state: nextState,
	};

	const handle429 = async () => {
		nextState.backoffUntil = chooseBackoffUntil(Date.now());
		nextState.updatedAt = new Date().toISOString();
		summary.backoffUntil = nextState.backoffUntil;
		await storeState(redis, nextState);
		return { ok: true, rateLimited: true, ...summary, state: nextState };
	};

	const processList = async (kind: 'individual' | 'firm', ids: string[], isDiscovery: boolean) => {
		for (const id of ids) {
			try {
				const result = await processCandidate(redis, graph, kind, id);
				summary.processed += 1;
				if (result.found) {
					summary.updated += 1;
					if (isDiscovery) summary.discovered += 1;
				}
				if (kind === 'individual') {
					if (isDiscovery) nextState.discovery.individualNext = Number(id) + 1;
					else nextState.updateIndex.individual = Math.max(0, Number(id) - 1);
				} else {
					if (isDiscovery) nextState.discovery.firmNext = Number(id) + 1;
					else nextState.updateIndex.firm = Math.max(0, Number(id) - 1);
				}
				await storeState(redis, nextState);
			} catch (error: any) {
				if (Number(error?.status || error?.response?.status) === 429) {
					return await handle429();
				}
				summary.processed += 1;
				summary.skippedNoData += 1;
				if (kind === 'individual') {
					if (isDiscovery) nextState.discovery.individualNext = Number(id) + 1;
					else nextState.updateIndex.individual = Math.max(0, Number(id) - 1);
				} else {
					if (isDiscovery) nextState.discovery.firmNext = Number(id) + 1;
					else nextState.updateIndex.firm = Math.max(0, Number(id) - 1);
				}
				await storeState(redis, nextState);
			}
		}
		return null;
	};

	// 1) Discover higher-number CRDs first.
	const discoveryIndividuals = buildDiscoveryCandidates(Math.max(state.discovery.individualNext, maxIndividual + 1), discoveryBatch);
	const discoveryFirms = buildDiscoveryCandidates(Math.max(state.discovery.firmNext, maxFirm + 1), discoveryBatch);
	let result = await processList('individual', discoveryIndividuals, true);
	if (result) return result;
	result = await processList('firm', discoveryFirms, true);
	if (result) return result;

	// 2) Backfill existing CRDs from high to low.
	const descendingIndividuals = [...individualIds].sort(numericSortDesc);
	const descendingFirms = [...firmIds].sort(numericSortDesc);
	const updateIndividuals = buildUpdateCandidates(descendingIndividuals, state.updateIndex.individual, updateBatch);
	const updateFirms = buildUpdateCandidates(descendingFirms, state.updateIndex.firm, updateBatch);
	result = await processList('individual', updateIndividuals, false);
	if (result) return result;
	result = await processList('firm', updateFirms, false);
	if (result) return result;

	nextState.updateIndex.individual = nextThreshold(updateIndividuals, updateIndividuals.length);
	nextState.updateIndex.firm = nextThreshold(updateFirms, updateFirms.length);
	nextState.updatedAt = new Date().toISOString();
	await storeState(redis, nextState);

	try {
		await redis.lpush(
			MONITOR_KEY,
			JSON.stringify({
				ts: new Date().toISOString(),
				action: 'external-validity-cron',
				processed: summary.processed,
				discovered: summary.discovered,
				updated: summary.updated,
				backoffUntil: nextState.backoffUntil,
				state: nextState,
			}),
		);
		await redis.ltrim(MONITOR_KEY, 0, 199);
	} catch {
		// ignore monitoring errors
	}

	return { ok: true, ...summary, state: nextState };
}
