/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * graphStore.ts – Module-level graph file cache and helper utilities.
 * Shared by /api/finra/graph, /expand, /nodes-by-ids, /graph-search, /graph-append
 */
import { readFile, writeFile, access, mkdir, rename, unlink, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Redis } from '@upstash/redis';
import { setStringIfValid } from '@/lib/redisCache';
import { gzipOffload, gunzipOffload } from './gzipWorker';
import { GRAPH_FILE, RECENT_SEEDS_FILE, SEED_BANK_FILE, SEED_PROFILES_FILE, SEEDS_FILE } from './graphDataPaths';

const REDIS_GRAPH_KEY = 'finra:graph';
const REDIS_GRAPH_UPDATED_AT_KEY = 'finra:graph:updated-at';
const REDIS_SEED_BANK_KEY = 'finra:seed-bank';
const REDIS_RECENT_SEEDS_KEY = 'finra:recent-seeds';
const EMPTY_GRAPH = { nodes: [], links: [], meta: {} };

type SeedBank = {
	individualIds: string[];
	firmIds: string[];
	entityIds: string[];
	otherIds: string[];
	allNodeIds: string[];
	nameByNumber: {
		individual: Record<string, string>;
		firm: Record<string, string>;
	};
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

export type SeedLookupKind = 'individual' | 'firm';

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
let _graphAdjacency: Map<string, Set<string>> | null = null;
const GRAPH_CACHE_TTL_MS = 1 * 60 * 1000; // 1 min (reduced from 5 min)
let _graphBootstrapPromise: Promise<boolean> | null = null;
const execFileAsync = promisify(execFile);

export function invalidateGraphCache() {
	_graphCache = null;
	_graphCacheAt = 0;
	_graphAdjacency = null;
}

if (process.env.NODE_ENV !== 'test') {
	import('chokidar')
		.then(({ default: chokidar }) => {
			chokidar
				.watch(GRAPH_FILE, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } })
				.on('change', () => {
					invalidateGraphCache();
				})
				.on('unlink', () => {
					invalidateGraphCache();
				});
		})
		.catch(() => {});
}

export function getGraphAdjacency(graph: any): Map<string, Set<string>> {
	if (_graphAdjacency && _graphCache === graph) {
		return _graphAdjacency;
	}

	const adjacency = new Map<string, Set<string>>();
	const links = Array.isArray(graph.links) ? graph.links : [];

	for (const link of links) {
		const sourceId = resolveId(link.source);
		const targetId = resolveId(link.target);
		if (!sourceId || !targetId) continue;

		if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
		if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());

		adjacency.get(sourceId)!.add(targetId);
		adjacency.get(targetId)!.add(sourceId);
	}

	if (_graphCache === graph) {
		_graphAdjacency = adjacency;
	}
	return adjacency;
}

export async function getNeighborsForNodes(nodeIds: string[], hops: number | 'all' = 1) {
	const graph = await getFullGraph();
	const adjacency = getGraphAdjacency(graph);

	const visitedIds = new Set<string>();
	const distanceById = new Map<string, number>();
	const queue: string[] = [];

	nodeIds.forEach((id) => {
		if (id && adjacency.has(id)) {
			visitedIds.add(id);
			distanceById.set(id, 0);
			queue.push(id);
		}
	});

	for (let index = 0; index < queue.length; index += 1) {
		const currentId = queue[index];
		const currentDistance = distanceById.get(currentId) ?? 0;
		if (hops !== 'all' && currentDistance >= hops) continue;

		for (const neighborId of adjacency.get(currentId) || []) {
			if (visitedIds.has(neighborId)) continue;
			visitedIds.add(neighborId);
			distanceById.set(neighborId, currentDistance + 1);
			queue.push(neighborId);
		}
	}

	const nodes: any[] = graph.nodes || [];
	const links: any[] = graph.links || [];

	const resultNodes = nodes.filter((node) => visitedIds.has(node.id));
	const resultLinks = links.filter((link) => {
		const sourceId = resolveId(link.source);
		const targetId = resolveId(link.target);
		return visitedIds.has(sourceId!) && visitedIds.has(targetId!);
	});

	return { nodes: resultNodes, links: resultLinks };
}

export async function getNeighborsForNode(nodeId: string, hops: number | 'all' = 1) {
	return getNeighborsForNodes([nodeId], hops);
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

// Ensure each node has a non-placeholder-visible label before writing to
// a shared cache (Redis). This guards against storing numeric-only or
// CRD-like labels that the UI treats as placeholders and hides.
function normalizeGraphLabelsInPlace(graph: any) {
	if (!graph || !Array.isArray(graph.nodes)) return graph;
	for (const node of graph.nodes) {
		try {
			const label = String(node?.label || node?.name || node?.displayName || '').trim();
			const isNumeric = /^\d+$/.test(label);
			const isCrdLike = /^(?:crd|sec)#?\s*\d+$/i.test(label) || /^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(label) || /^8-\d+$/i.test(label);
			if (!label || isNumeric || isCrdLike) {
				const idText = String(node?.id || '').trim();
				node.label = idText ? `Node ${idText}` : label || '';
			}
		} catch (e) {
			// ignore per-node errors
		}
	}
	return graph;
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
		nameByNumber: { individual: {}, firm: {} },
		updatedAt: new Date(0).toISOString(),
		counts: { individuals: 0, firms: 0, entities: 0, others: 0, totalNodes: 0 },
	};
}

function uniqueSortedIds(values: unknown[]): string[] {
	return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function firstMeaningfulText(...values: unknown[]): string {
	for (const value of values) {
		const text = String(value || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (text) return text;
	}
	return '';
}

function normalizeSeedName(value: unknown): string {
	const text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return '';
	if (
		/^\d+$/.test(text) ||
		/^\d+-\d+$/.test(text) ||
		/^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(text) ||
		/^8-\d+$/i.test(text) ||
		/^person\s+\d+$/i.test(text) ||
		/^firm\s+\d+$/i.test(text)
	) {
		return '';
	}
	return text;
}

function getSeedNodeDisplayName(node: any): string {
	const basic = node?.basicInformation || {};
	if (node?.group === 'individual') {
		const fullName = [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ');
		return normalizeSeedName(firstMeaningfulText(fullName, basic.name, node?.name, node?.personName, node?.displayName, node?.legalName, node?.label));
	}
	if (node?.group === 'firm') {
		return normalizeSeedName(
			firstMeaningfulText(
				basic.firmName,
				basic.name,
				node?.firmName,
				node?.organizationName,
				node?.organization_name,
				node?.companyName,
				node?.name,
				node?.displayName,
				node?.legalName,
				node?.label,
			),
		);
	}
	return '';
}

function getNumericSeedNumber(nodeId: string, group: 'individual' | 'firm'): string {
	const prefix = group === 'individual' ? 'person:' : 'firm:';
	if (!nodeId.startsWith(prefix)) return '';
	const rawNumber = nodeId.slice(prefix.length).trim();
	return /^\d+$/.test(rawNumber) ? rawNumber : '';
}

function normalizeSeedNameMap(raw: unknown): { individual: Record<string, string>; firm: Record<string, string> } {
	const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const normalizeEntries = (entries: unknown) => {
		const output: Record<string, string> = {};
		if (!entries || typeof entries !== 'object') return output;
		for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
			const normalizedKey = String(key || '').trim();
			const normalizedValue = normalizeSeedName(value);
			if (!/^\d+$/.test(normalizedKey) || !normalizedValue) continue;
			output[normalizedKey] = normalizedValue;
		}
		return output;
	};

	return {
		individual: normalizeEntries(input.individual),
		firm: normalizeEntries(input.firm),
	};
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
	return ids.sort((left, right) => Number(right) - Number(left));
}

function buildSeedBankFromGraph(graph: any): SeedBank {
	const normalizedGraph = normalizeGraphPayload(graph);
	const individuals: string[] = [];
	const firms: string[] = [];
	const entities: string[] = [];
	const others: string[] = [];
	const allNodeIds: string[] = [];
	const nameByNumber = { individual: {} as Record<string, string>, firm: {} as Record<string, string> };

	for (const node of normalizedGraph.nodes) {
		const nodeId = resolveId(node);
		if (!nodeId) continue;
		allNodeIds.push(nodeId);
		switch (node?.group) {
			case 'individual':
				individuals.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'individual');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.individual[rawNumber] = displayName;
				}
				break;
			case 'firm':
				firms.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'firm');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.firm[rawNumber] = displayName;
				}
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
		nameByNumber,
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
		nameByNumber: normalizeSeedNameMap(candidate.nameByNumber),
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

function isSessionResetEmptyGraph(graph: any) {
	if (!graph || typeof graph !== 'object') return false;
	const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
	const linkCount = Array.isArray(graph.links) ? graph.links.length : 0;
	const sourceLabel = String(graph.meta?.sourceLabel || '').trim();
	return nodeCount === 0 && linkCount === 0 && sourceLabel === '(session reset)';
}

async function ensureGraphFileFromCache() {
	let shouldForceFullRebuild = false;
	if (await localGraphFileExists()) {
		try {
			const diskGraph = await readGraphFromDisk();
			if (diskGraph && !isSessionResetEmptyGraph(diskGraph)) return true;
			shouldForceFullRebuild = true;
		} catch {
			// Fall through to rebuild attempt.
		}
	}
	if (_graphBootstrapPromise) return _graphBootstrapPromise;

	_graphBootstrapPromise = (async () => {
		try {
			const scriptPath = path.join(process.cwd(), 'scripts', 'build_graph_from_cache.js');
			const scriptArgs = [scriptPath, '--employment-scope', 'current', '--no-redis'];
			if (shouldForceFullRebuild) scriptArgs.push('--full');
			await execFileAsync(process.execPath, scriptArgs, {
				cwd: process.cwd(),
				env: process.env,
				maxBuffer: 10 * 1024 * 1024,
			});
			return await localGraphFileExists();
		} catch (error) {
			console.warn('Failed to rebuild missing finra-graph.json from cache.', error);
			return false;
		}
	})().finally(() => {
		_graphBootstrapPromise = null;
	});

	return _graphBootstrapPromise;
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
		await setStringIfValid(REDIS_SEED_BANK_KEY, JSON.stringify(seedBank));
		return;
	}
	await saveSeedBankToDisk(seedBank);
}

export async function saveRecentSeedsToStore(recentSeeds: RecentSeeds): Promise<void> {
	const normalized = normalizeRecentSeedsPayload(recentSeeds);
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_RECENT_SEEDS_KEY, JSON.stringify(normalized));
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

export async function getSeedNameByNumber(kind: SeedLookupKind, id: string): Promise<string | null> {
	const normalizedId = String(id || '').trim();
	if (!/^\d+$/.test(normalizedId)) return null;
	const seedBank = await getSeedBankFromStore();
	const lookup = seedBank.nameByNumber?.[kind];
	const value = lookup && typeof lookup === 'object' ? lookup[normalizedId] : '';
	return typeof value === 'string' && value.trim() ? value.trim() : null;
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
	// Normalize labels before writing to shared Redis so clients won't
	// receive placeholder-only labels.
	try {
		normalizeGraphLabelsInPlace(diskGraph);
	} catch (e) {}
	await setStringIfValid(REDIS_GRAPH_KEY, JSON.stringify(diskGraph));
	await syncSeedBankFromGraph(diskGraph);
	return diskGraph;
}

export async function getFullGraph() {
	const now = Date.now();
	const redis = getRedis();

	// Check for remote cache buster if we have a cached graph. This ensures
	// warm instances detect dashboard updates immediately even before TTL expires.
	if (_graphCache && redis) {
		try {
			const updatedAt = await redis.get<number>(REDIS_GRAPH_UPDATED_AT_KEY);
			if (updatedAt && Number(updatedAt) > _graphCacheAt) {
				_graphCache = null;
				_graphCacheAt = 0;
			}
		} catch (e) {
			// ignore redis error and use cached graph or fallback
		}
	}

	if (_graphCache && now - _graphCacheAt < GRAPH_CACHE_TTL_MS) return _graphCache;
	if (_graphCache && now - _graphCacheAt >= GRAPH_CACHE_TTL_MS) _graphCache = null;

	if (redis) {
		try {
			let raw = await redis.get<string>(REDIS_GRAPH_KEY);

			if (!raw) {
				// check for chunked manifest
				const manifestKey = `${REDIS_GRAPH_KEY}:manifest`;
				const rawManifest = await redis.get<string>(manifestKey);
				if (rawManifest) {
					const manifest = typeof rawManifest === 'string' ? JSON.parse(rawManifest) : rawManifest;
					const parts = [];
					for (let i = 0; i < (manifest.parts || 0); i++) {
						const part = await redis.get<string>(`${REDIS_GRAPH_KEY}:part:${i}`);
						if (part) parts.push(part);
					}
					if (parts.length === manifest.parts) {
						raw = parts.join('');
					}
				}
			}

			if (raw) {
				// Support both legacy JSON string and new gzip+base64 compressed payloads.
				let parsedRaw: any = raw;
				if (typeof raw === 'string') {
					const firstChar = raw.trim().charAt(0);
					if (firstChar === '{' || firstChar === '[') {
						parsedRaw = JSON.parse(raw);
					} else {
						try {
							// Offload gunzip to worker; redis stores base64 gzipped payloads.
							const json = await gunzipOffload(raw as string);
							parsedRaw = JSON.parse(json);
						} catch (e) {
							// fallback to attempting JSON parse
							try {
								parsedRaw = JSON.parse(raw);
							} catch (ee) {
								parsedRaw = null;
							}
						}
					}
				}
				if (parsedRaw) {
					const redisGraph = parseGraphPayload(parsedRaw, 'Redis graph payload');
					const isRedisGraphEmpty = (redisGraph.nodes?.length || 0) === 0 && (redisGraph.links?.length || 0) === 0;
					const redisSourceLabel = String(redisGraph.meta?.sourceLabel || '').trim();
					let useDiskGraph = false;

					if (isRedisGraphEmpty && redisSourceLabel === '(session reset)') {
						const diskGraph = await readGraphFromDisk();
						if (diskGraph && (diskGraph.nodes?.length || 0) > 0) {
							try {
								normalizeGraphLabelsInPlace(diskGraph);
								await setStringIfValid(REDIS_GRAPH_KEY, JSON.stringify(diskGraph));
								await syncSeedBankFromGraph(diskGraph);
							} catch (error) {
								console.warn('Failed to restore Redis graph from disk after reset.', error);
							}
							_graphCache = diskGraph;
							_graphCacheAt = now;
							useDiskGraph = true;
						}
					}

					if (!useDiskGraph) {
						_graphCache = redisGraph;
						_graphCacheAt = now;
						if (process.env.VERCEL !== '1' && !(await localGraphFileExists())) {
							try {
								await writeJsonFileAtomic(GRAPH_FILE, _graphCache);
								await syncSeedBankFromGraph(_graphCache);
							} catch (error) {
								console.warn('Failed to restore local finra-graph.json from Redis payload.', error);
							}
						}
					}

					return _graphCache;
				}
			}
			if (await ensureGraphFileFromCache()) {
				const diskGraph = await readGraphFromDisk();
				if (diskGraph) {
					try {
						try {
							normalizeGraphLabelsInPlace(diskGraph);
						} catch (e) {}
						await setStringIfValid(REDIS_GRAPH_KEY, JSON.stringify(diskGraph));
						await syncSeedBankFromGraph(diskGraph);
					} catch (error) {
						console.warn('Failed to sync rebuilt finra-graph.json into Redis.', error);
					}
					_graphCache = diskGraph;
					_graphCacheAt = now;
					return _graphCache;
				}
			}
			const boot = await bootstrapGraphFromDisk(redis);
			_graphCache = boot ?? { ...EMPTY_GRAPH };
			_graphCacheAt = now;
			return _graphCache;
		} catch (e) {
			// fall back to disk
		}
	}

	if (!(await ensureGraphFileFromCache())) {
		_graphCache = { ...EMPTY_GRAPH };
		_graphCacheAt = now;
		return _graphCache;
	}
	_graphCache = (await readGraphFromDisk()) || { ...EMPTY_GRAPH };
	_graphCacheAt = now;
	return _graphCache;
}

export async function saveGraph(data: any) {
	const redis = getRedis();
	if (redis) {
		try {
			normalizeGraphLabelsInPlace(data);
		} catch (e) {}
		// Before storing in Redis, strip simulation state and compress payload
		try {
			const compact = {
				nodes: Array.isArray(data.nodes) ? data.nodes.map((n: any) => stripSimState(n)) : [],
				links:
					Array.isArray(data.links) ?
						data.links.map((l: any) => ({
							source: typeof l.source === 'object' ? (l.source.id ?? l.source) : l.source,
							target: typeof l.target === 'object' ? (l.target.id ?? l.target) : l.target,
							relationship: l.relationship,
							firmId: l.firmId || l.firm_id || null,
							startDate: l.startDate || l.start || null,
							endDate: l.endDate || l.end || null,
						}))
					:	[],
				meta: data.meta || {},
			};
			const json = JSON.stringify(compact);
			// Offload gzip to background worker to avoid blocking the event loop
			const b64 = await gzipOffload(json);
			await setStringIfValid(REDIS_GRAPH_KEY, b64);
			await redis.set(REDIS_GRAPH_UPDATED_AT_KEY, Date.now());
		} catch (e) {
			// On any failure, fall back to storing plain JSON
			await setStringIfValid(REDIS_GRAPH_KEY, JSON.stringify(data));
			await redis.set(REDIS_GRAPH_UPDATED_AT_KEY, Date.now());
		}
	} else {
		await writeJsonFileAtomic(GRAPH_FILE, data);
	}
	await syncSeedBankFromGraph(data);
	invalidateGraphCache();
}

export async function clearGraphStore({ clearRecentSeeds = true }: { clearRecentSeeds?: boolean } = {}) {
	const emptyGraph = {
		...EMPTY_GRAPH,
		meta: {
			generated: new Date().toISOString(),
			sourceLabel: '(session reset)',
			totalIndividuals: 0,
			totalFirms: 0,
			totalEntities: 0,
			totalNodes: 0,
			totalLinks: 0,
		},
	};

	const redis = getRedis();
	if (redis) {
		await saveGraph(emptyGraph);
	} else {
		invalidateGraphCache();
	}

	if (clearRecentSeeds) {
		await saveRecentSeedsToStore(createEmptyRecentSeeds());
	}
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
			await setStringIfValid(REDIS_PROFILES_KEY, JSON.stringify(data));
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
		await setStringIfValid(REDIS_PROFILES_KEY, JSON.stringify(data));
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
			await setStringIfValid(REDIS_SEEDS_KEY, JSON.stringify(data));
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
		await setStringIfValid(REDIS_SEEDS_KEY, JSON.stringify(seeds));
	} else {
		await writeJsonFileAtomic(SEEDS_FILE, seeds);
	}
	invalidateSeedsCache();
}
