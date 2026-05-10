/**
 * graphStore.ts – Module-level graph file cache and helper utilities.
 * Shared by /api/finra/graph, /expand, /nodes-by-ids, /graph-search, /graph-append
 */
import { readFile, writeFile, access, mkdir, rename, unlink, constants } from 'node:fs/promises';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { GRAPH_FILE, RECENT_SEEDS_FILE, SEED_BANK_FILE, SEED_PROFILES_FILE, SEEDS_FILE } from './constants';

const REDIS_GRAPH_KEY = 'finra:graph';
const REDIS_SEED_BANK_KEY = 'finra:seed-bank';
const REDIS_RECENT_SEEDS_KEY = 'finra:recent-seeds';
const EMPTY_GRAPH = { nodes: [], links: [], meta: {} };

type SeedBank = {
	individualIds: string[];
	firmIds: string[];
	entityIds: string[];
	otherIds: string[];
	allNodeIds: string[];
	updatedAt: string;
	counts: {
		individuals: number;
		firms: number;
		entities: number;
		others: number;
		totalNodes: number;
	};
};

type RecentSeeds = {
	individualIds: string[];
	firmIds: string[];
	updatedAt: string;
};

let _redis: Redis | null = null;
function getRedis(): Redis | null {
	if (_redis !== null) return _redis;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) _redis = new Redis({ url, token });
	return _redis;
}

export let _graphCache: any = null;
let _graphCacheAt = 0;
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

if (process.env.NODE_ENV !== 'test') {
	import('chokidar')
		.then(({ default: chokidar }) => {
			chokidar
				.watch(GRAPH_FILE, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } })
				.on('change', () => {
					_graphCache = null;
					_graphCacheAt = 0;
				})
				.on('unlink', () => {
					_graphCache = null;
					_graphCacheAt = 0;
				});
		})
		.catch(() => {});
}

function normalizeGraphPayload(data: any) {
	if (!data || typeof data !== 'object') return { ...EMPTY_GRAPH };
	const normalizedLinks =
		Array.isArray(data.links) ?
			data.links.map((link: any) => {
				if (!link || typeof link !== 'object') return link;
				const sourceId = String(link.source?.id ?? link.source ?? '');
				const targetId = String(link.target?.id ?? link.target ?? '');
				const inferredRelationship =
					sourceId.startsWith('person:') && targetId.startsWith('firm:') ? 'employed_by'
					: (sourceId.startsWith('firm:') || sourceId.startsWith('entity:')) && targetId.startsWith('firm:') ? 'controls'
					: '';
				const relationship =
					typeof link.relationship === 'string' && link.relationship ? link.relationship
					: typeof link.type === 'string' && link.type ? link.type
					: inferredRelationship;
				const normalizedLink = relationship ? { ...link, relationship } : { ...link };
				if (normalizedLink.relationship === 'previous_employed_by' && normalizedLink.isCurrent === undefined) normalizedLink.isCurrent = false;
				if ('type' in normalizedLink) delete (normalizedLink as any).type;
				return normalizedLink;
			})
		:	[];
	return {
		nodes: Array.isArray(data.nodes) ? data.nodes : [],
		links: normalizedLinks,
		meta: data.meta && typeof data.meta === 'object' ? data.meta : {},
	};
}

function parseGraphPayload(raw: unknown, sourceLabel: string) {
	if (typeof raw === 'string') {
		if (!raw.trim()) return { ...EMPTY_GRAPH };
		try {
			return normalizeGraphPayload(JSON.parse(raw));
		} catch (error) {
			console.warn(`Failed to parse ${sourceLabel}; falling back to empty graph.`, error);
			return { ...EMPTY_GRAPH };
		}
	}
	return normalizeGraphPayload(raw);
}

function createEmptySeedBank(): SeedBank {
	return {
		individualIds: [],
		firmIds: [],
		entityIds: [],
		otherIds: [],
		allNodeIds: [],
		updatedAt: new Date(0).toISOString(),
		counts: { individuals: 0, firms: 0, entities: 0, others: 0, totalNodes: 0 },
	};
}

function uniqueSortedIds(values: unknown[]): string[] {
	return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function uniqueRecentIds(values: unknown[]): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const value of values) {
		const normalized = String(value || '').trim();
		if (!/^[0-9]+$/.test(normalized) || seen.has(normalized)) continue;
		seen.add(normalized);
		ids.push(normalized);
	}
	return ids;
}

function buildSeedBankFromGraph(graph: any): SeedBank {
	const normalizedGraph = normalizeGraphPayload(graph);
	const individuals: string[] = [];
	const firms: string[] = [];
	const entities: string[] = [];
	const others: string[] = [];
	const allNodeIds: string[] = [];

	for (const node of normalizedGraph.nodes) {
		const nodeId = resolveId(node);
		if (!nodeId) continue;
		allNodeIds.push(nodeId);
		switch (node?.group) {
			case 'individual':
				individuals.push(nodeId);
				break;
			case 'firm':
				firms.push(nodeId);
				break;
			case 'entity':
				entities.push(nodeId);
				break;
			default:
				others.push(nodeId);
				break;
		}
	}

	const individualIds = uniqueSortedIds(individuals);
	const firmIds = uniqueSortedIds(firms);
	const entityIds = uniqueSortedIds(entities);
	const otherIds = uniqueSortedIds(others);
	const uniqueAllNodeIds = uniqueSortedIds(allNodeIds);

	return {
		individualIds,
		firmIds,
		entityIds,
		otherIds,
		allNodeIds: uniqueAllNodeIds,
		updatedAt: new Date().toISOString(),
		counts: {
			individuals: individualIds.length,
			firms: firmIds.length,
			entities: entityIds.length,
			others: otherIds.length,
			totalNodes: uniqueAllNodeIds.length,
		},
	};
}

function normalizeSeedBankPayload(raw: unknown): SeedBank {
	if (!raw || typeof raw !== 'object') return createEmptySeedBank();
	const candidate = raw as Partial<SeedBank>;
	const individualIds = uniqueSortedIds(Array.isArray(candidate.individualIds) ? candidate.individualIds : []);
	const firmIds = uniqueSortedIds(Array.isArray(candidate.firmIds) ? candidate.firmIds : []);
	const entityIds = uniqueSortedIds(Array.isArray(candidate.entityIds) ? candidate.entityIds : []);
	const otherIds = uniqueSortedIds(Array.isArray(candidate.otherIds) ? candidate.otherIds : []);
	const allNodeIds = uniqueSortedIds(
		Array.isArray(candidate.allNodeIds) && candidate.allNodeIds.length ? candidate.allNodeIds : [...individualIds, ...firmIds, ...entityIds, ...otherIds],
	);

	return {
		individualIds,
		firmIds,
		entityIds,
		otherIds,
		allNodeIds,
		updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : new Date().toISOString(),
		counts: {
			individuals: individualIds.length,
			firms: firmIds.length,
			entities: entityIds.length,
			others: otherIds.length,
			totalNodes: allNodeIds.length,
		},
	};
}

function createEmptyRecentSeeds(): RecentSeeds {
	return { individualIds: [], firmIds: [], updatedAt: new Date(0).toISOString() };
}

function normalizeRecentSeedsPayload(raw: unknown): RecentSeeds {
	if (!raw || typeof raw !== 'object') return createEmptyRecentSeeds();
	const candidate = raw as Partial<RecentSeeds>;
	return {
		individualIds: uniqueRecentIds(Array.isArray(candidate.individualIds) ? candidate.individualIds : []),
		firmIds: uniqueRecentIds(Array.isArray(candidate.firmIds) ? candidate.firmIds : []),
		updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : new Date().toISOString(),
	};
}

async function localGraphFileExists() {
	try {
		await access(GRAPH_FILE, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function readGraphFromDisk() {
	if (!(await localGraphFileExists())) return null;
	const raw = await readFile(GRAPH_FILE, 'utf-8');
	return parseGraphPayload(raw, GRAPH_FILE);
}

async function readSeedBankFromDisk() {
	try {
		const raw = await readFile(SEED_BANK_FILE, 'utf-8');
		return normalizeSeedBankPayload(JSON.parse(raw));
	} catch {
		return null;
	}
}

async function readRecentSeedsFromDisk() {
	try {
		const raw = await readFile(RECENT_SEEDS_FILE, 'utf-8');
		return normalizeRecentSeedsPayload(JSON.parse(raw));
	} catch {
		return null;
	}
}

async function writeTextFileAtomic(filePath: string, contents: string) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		await writeFile(tempPath, contents, 'utf-8');
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		throw error;
	}
}

async function writeJsonFileAtomic(filePath: string, data: unknown) {
	await writeTextFileAtomic(filePath, JSON.stringify(data, null, 2));
}

async function saveSeedBankToDisk(seedBank: SeedBank) {
	await writeJsonFileAtomic(SEED_BANK_FILE, seedBank);
}

async function saveRecentSeedsToDisk(recentSeeds: RecentSeeds) {
	await writeJsonFileAtomic(RECENT_SEEDS_FILE, recentSeeds);
}

export async function saveSeedBankToStore(seedBank: SeedBank): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await redis.set(REDIS_SEED_BANK_KEY, JSON.stringify(seedBank));
		return;
	}
	await saveSeedBankToDisk(seedBank);
}

export async function saveRecentSeedsToStore(recentSeeds: RecentSeeds): Promise<void> {
	const normalized = normalizeRecentSeedsPayload(recentSeeds);
	const redis = getRedis();
	if (redis) {
		await redis.set(REDIS_RECENT_SEEDS_KEY, JSON.stringify(normalized));
		return;
	}
	await saveRecentSeedsToDisk(normalized);
}

async function syncSeedBankFromGraph(graph: any): Promise<SeedBank> {
	const seedBank = buildSeedBankFromGraph(graph);
	await saveSeedBankToStore(seedBank);
	return seedBank;
}

export async function getSeedBankFromStore(): Promise<SeedBank> {
	const redis = getRedis();
	if (redis) {
		const raw = await redis.get<string>(REDIS_SEED_BANK_KEY);
		if (raw) return normalizeSeedBankPayload(typeof raw === 'string' ? JSON.parse(raw) : raw);
		const graph = await getFullGraph();
		return syncSeedBankFromGraph(graph);
	}

	const diskSeedBank = await readSeedBankFromDisk();
	if (diskSeedBank) return diskSeedBank;

	const graph = await getFullGraph();
	return syncSeedBankFromGraph(graph);
}

export async function getRecentSeedsFromStore(): Promise<RecentSeeds> {
	const redis = getRedis();
	if (redis) {
		const raw = await redis.get<string>(REDIS_RECENT_SEEDS_KEY);
		if (raw) return normalizeRecentSeedsPayload(typeof raw === 'string' ? JSON.parse(raw) : raw);
		return createEmptyRecentSeeds();
	}

	const diskRecentSeeds = await readRecentSeedsFromDisk();
	return diskRecentSeeds || createEmptyRecentSeeds();
}

export async function rememberRecentSeed(kind: 'individual' | 'firm', id: string, maxItems = 250): Promise<void> {
	const normalizedId = String(id || '').trim();
	if (!/^[0-9]+$/.test(normalizedId)) return;

	const recentSeeds = await getRecentSeedsFromStore();
	const nextRecentSeeds: RecentSeeds = {
		...recentSeeds,
		updatedAt: new Date().toISOString(),
		individualIds: kind === 'individual' ? uniqueRecentIds([normalizedId, ...recentSeeds.individualIds]).slice(0, maxItems) : recentSeeds.individualIds,
		firmIds: kind === 'firm' ? uniqueRecentIds([normalizedId, ...recentSeeds.firmIds]).slice(0, maxItems) : recentSeeds.firmIds,
	};

	await saveRecentSeedsToStore(nextRecentSeeds);
}

async function bootstrapGraphFromDisk(redis: Redis) {
	const diskGraph = await readGraphFromDisk();
	if (!diskGraph) return null;
	await redis.set(REDIS_GRAPH_KEY, JSON.stringify(diskGraph));
	await syncSeedBankFromGraph(diskGraph);
	return diskGraph;
}

export async function getFullGraph() {
	const now = Date.now();
	if (_graphCache && now - _graphCacheAt < GRAPH_CACHE_TTL_MS) return _graphCache;
	if (_graphCache && now - _graphCacheAt >= GRAPH_CACHE_TTL_MS) _graphCache = null;

	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_GRAPH_KEY);
			if (raw) {
				_graphCache = parseGraphPayload(typeof raw === 'string' ? JSON.parse(raw) : raw, 'Redis graph payload');
				_graphCacheAt = now;
				return _graphCache;
			}
			const boot = await bootstrapGraphFromDisk(redis);
			_graphCache = boot ?? { ...EMPTY_GRAPH };
			_graphCacheAt = now;
			return _graphCache;
		} catch (e) {
			// fall back to disk
		}
	}

	if (!(await localGraphFileExists())) {
		_graphCache = { ...EMPTY_GRAPH };
		_graphCacheAt = now;
		return _graphCache;
	}
	_graphCache = await readGraphFromDisk();
	_graphCacheAt = now;
	return _graphCache;
}

export async function saveGraph(data: any) {
	const redis = getRedis();
	if (redis) {
		await redis.set(REDIS_GRAPH_KEY, JSON.stringify(data));
	} else {
		await writeJsonFileAtomic(GRAPH_FILE, data);
	}
	await syncSeedBankFromGraph(data);
	invalidateGraphCache();
}

export function invalidateGraphCache() {
	_graphCache = null;
	_graphCacheAt = 0;
}

export async function graphFileExists() {
	const redis = getRedis();
	if (redis) {
		const exists = await redis.exists(REDIS_GRAPH_KEY);
		if (exists > 0) return true;
		return localGraphFileExists();
	}
	return localGraphFileExists();
}

const D3_SIM_KEYS = ['x', 'y', 'vx', 'vy', 'fx', 'fy', 'index', '_detailLoaded'];
export function stripSimState(obj: Record<string, any>) {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(obj)) if (!D3_SIM_KEYS.includes(k)) out[k] = v;
	return out;
}

export function resolveId(ref: any): string | null {
	if (ref && typeof ref === 'object') return ref.id ?? null;
	return ref ?? null;
}

let _seedsCache: string[] | null = null;
let _profilesCache: any = null;

export function getSeedsCache() {
	return _seedsCache;
}
export function setSeedsCache(v: string[]) {
	_seedsCache = v;
}
export function invalidateSeedsCache() {
	_seedsCache = null;
}

export function getProfilesCache() {
	return _profilesCache;
}
export function setProfilesCache(v: any) {
	_profilesCache = v;
}
export function invalidateProfilesCache() {
	_profilesCache = null;
}

const REDIS_PROFILES_KEY = 'finra:seed-profiles';
const REDIS_SEEDS_KEY = 'finra:seeds';

export async function getProfilesFromStore(): Promise<any> {
	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_PROFILES_KEY);
			if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
			const data = JSON.parse(await readFile(SEED_PROFILES_FILE, 'utf-8'));
			await redis.set(REDIS_PROFILES_KEY, JSON.stringify(data));
			return data;
		} catch {
			return { profiles: [] };
		}
	}
	try {
		return JSON.parse(await readFile(SEED_PROFILES_FILE, 'utf-8'));
	} catch {
		return { profiles: [] };
	}
}

export async function saveProfilesToStore(data: any): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await redis.set(REDIS_PROFILES_KEY, JSON.stringify(data));
	} else {
		await writeJsonFileAtomic(SEED_PROFILES_FILE, data);
	}
	invalidateProfilesCache();
}

export async function getSeedsFromStore(): Promise<string[]> {
	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_SEEDS_KEY);
			if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
			const data = JSON.parse(await readFile(SEEDS_FILE, 'utf-8'));
			await redis.set(REDIS_SEEDS_KEY, JSON.stringify(data));
			return data;
		} catch {
			return [];
		}
	}
	try {
		return JSON.parse(await readFile(SEEDS_FILE, 'utf-8'));
	} catch {
		return [];
	}
}

export async function saveSeedsToStore(seeds: string[]): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await redis.set(REDIS_SEEDS_KEY, JSON.stringify(seeds));
	} else {
		await writeJsonFileAtomic(SEEDS_FILE, seeds);
	}
	invalidateSeedsCache();
}
