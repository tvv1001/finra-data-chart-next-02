import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Redis } from '@upstash/redis';
import { setStringIfValid } from '@/lib/redisCache';
import { canCallExternalApis } from '@/lib/externalApiGate';

type MemStore = Map<string, { value: unknown; expiresAt: number }>;
type PrimedBundle = Record<string, unknown>;
type PrimedBundleName = 'finra-individual' | 'sec-individual' | 'finra-firm' | 'sec-firm';

let upstash: Redis | null = null;
let memStore: MemStore | null = null;
const primedBundleCache = new Map<PrimedBundleName, PrimedBundle | null>();

const EXTERNAL_API_MIN_INTERVAL_MS = Number(process.env.EXTERNAL_API_MIN_INTERVAL_MS || 1000);
const EXTERNAL_API_FAILURE_COOLDOWN_MS = Number(process.env.EXTERNAL_API_FAILURE_COOLDOWN_MS || 60_000);
const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';

const primedBundleBinFiles: Record<PrimedBundleName, string> = {
	'finra-individual': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'finra-individual.bin'),
	'sec-individual': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'sec-individual.bin'),
	'finra-firm': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'finra-firm.bin'),
	'sec-firm': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'sec-firm.bin'),
};

const lastExternalFetch = new Map<string, number>();
const lastExternalFailure = new Map<string, number>();

function normalizeKey(key: string): string {
	const lastColon = key.lastIndexOf(':');
	if (lastColon === -1) return key;
	const suffix = key.slice(lastColon + 1);
	if (!suffix.includes('=')) return key;
	const qs = new URLSearchParams(suffix);
	qs.delete('nrows');
	const entries: [string, string][] = [];
	for (const [k, v] of qs.entries()) entries.push([k, v]);
	entries.sort((a, b) => a[0].localeCompare(b[0]));
	return `${key.slice(0, lastColon + 1)}${new URLSearchParams(entries).toString()}`;
}

function getUpstash(): Redis | null {
	if (upstash !== null) return upstash;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) upstash = new Redis({ url, token });
	return upstash;
}

function getPrimedRedisKey(name: PrimedBundleName): string {
	return `primed:bundle:${name}`;
}

function getPrimedRedisMetaKey(name: PrimedBundleName): string {
	return `${getPrimedRedisKey(name)}:meta`;
}

function getPrimedRedisPartKey(name: PrimedBundleName, index: number): string {
	return `${getPrimedRedisKey(name)}:part:${index}`;
}

function getMem(): MemStore {
	if (!memStore) memStore = new Map();
	return memStore;
}

function normalizePrimedBundle(parsed: PrimedBundle): PrimedBundle {
	const normalized: PrimedBundle = {};
	for (const bundleKey of Object.keys(parsed)) {
		try {
			normalized[normalizeKey(bundleKey)] = parsed[bundleKey];
		} catch {
			normalized[bundleKey] = parsed[bundleKey];
		}
	}
	return normalized;
}

async function decodePrimedBundlePayload(raw: string): Promise<PrimedBundle | null> {
	try {
		const json = zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
		return normalizePrimedBundle(JSON.parse(json) as PrimedBundle);
	} catch {
		return null;
	}
}

async function getPrimedBundleFromRedis(name: PrimedBundleName): Promise<PrimedBundle | null> {
	const redis = getUpstash();
	if (!redis) return null;
	try {
		const raw = await redis.get<string>(getPrimedRedisKey(name));
		if (raw) {
			const decoded = await decodePrimedBundlePayload(raw);
			if (decoded) return decoded;
		}

		const rawMeta = await redis.get<string>(getPrimedRedisMetaKey(name));
		if (!rawMeta) return null;
		const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
		const chunkCount = Number(meta?.chunks || 0);
		if (!meta?.chunked || !Number.isFinite(chunkCount) || chunkCount <= 0) return null;

		const parts: string[] = [];
		for (let index = 0; index < chunkCount; index += 1) {
			const part = await redis.get<string>(getPrimedRedisPartKey(name, index));
			if (!part) return null;
			parts.push(part);
		}

		return decodePrimedBundlePayload(parts.join(''));
	} catch {
		return null;
	}
}

async function loadPrimedBundle(name: PrimedBundleName): Promise<PrimedBundle | null> {
	if (primedBundleCache.has(name)) return primedBundleCache.get(name) ?? null;

	const binPath = primedBundleBinFiles[name];
	try {
		const rawBin = await readFile(binPath);
		const decoded = await decodePrimedBundlePayload(rawBin.toString('base64'));
		if (decoded) {
			primedBundleCache.set(name, decoded);
			return decoded;
		}
	} catch {
		// fall through
	}

	const redisBundle = await getPrimedBundleFromRedis(name);
	primedBundleCache.set(name, redisBundle);
	return redisBundle;
}

function resolvePrimedBundleName(key: string): PrimedBundleName | null {
	if (key.startsWith('finra:individual:') && key.endsWith(`:${DEFAULT_INDIVIDUAL_QUERY}`)) return 'finra-individual';
	if (key.startsWith('sec:individual:') && key.endsWith(`:${DEFAULT_INDIVIDUAL_QUERY}`)) return 'sec-individual';
	if (key.startsWith('finra:firm:') && key.endsWith(`:${DEFAULT_FIRM_QUERY}`)) return 'finra-firm';
	if (key.startsWith('sec:firm:') && key.endsWith(`:${DEFAULT_FIRM_QUERY}`)) return 'sec-firm';
	return null;
}

async function getPrimedCacheValue<T>(key: string): Promise<T | null> {
	const normalizedKey = normalizeKey(key);
	const bundleName = resolvePrimedBundleName(normalizedKey);
	if (!bundleName) return null;
	const bundle = await loadPrimedBundle(bundleName);
	if (!bundle) return null;
	if (normalizedKey in bundle) return bundle[normalizedKey] as T;
	if (key in bundle) return bundle[key] as T;
	return null;
}

async function getDiskCacheValue<T>(key: string): Promise<T | null> {
	try {
		const parts = key.split(':');
		if (parts.length < 3) return null;
		const service = parts[0];
		const type = parts[1];
		const id = parts[2];

		if (!/^\d+$/.test(id) && !/^8-\d+$/i.test(id)) return null;

		let folder = '';
		let filePrefix = '';

		if (service === 'finra') {
			folder = 'brokercheck.finra.org';
			filePrefix = 'api.brokercheck.finra.org_search';
		} else if (service === 'sec') {
			folder = 'adviserinfo.sec.gov';
			filePrefix = 'api.adviserinfo.sec.gov_search';
		} else {
			return null;
		}

		const fileName = `${filePrefix}_${type}_${id}.json`;
		const filePath = path.join(process.cwd(), 'data', 'national', folder, fileName);

		try {
			await readFile(filePath);
		} catch {
			return null;
		}

		const content = await readFile(filePath, 'utf-8');
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

function memSet(map: MemStore, key: string, value: unknown, ttlSeconds: number) {
	const expiresAt = Date.now() + ttlSeconds * 1000;
	map.set(key, { value, expiresAt });
	setTimeout(() => {
		const current = map.get(key);
		if (current && current.expiresAt <= Date.now()) map.delete(key);
	}, ttlSeconds * 1000).unref?.();
}

function memGet(map: MemStore, key: string): unknown | null {
	const item = map.get(key);
	if (!item) return null;
	if (item.expiresAt <= Date.now()) {
		map.delete(key);
		return null;
	}
	return item.value;
}

function getExternalService(key: string) {
	if (key.startsWith('finra:')) return 'finra';
	if (key.startsWith('sec:')) return 'sec';
	return '';
}

function shouldSkipExternalFetch(service: string) {
	if (!service) return false;
	const now = Date.now();
	const lastFailureAt = lastExternalFailure.get(service) || 0;
	if (now - lastFailureAt < EXTERNAL_API_FAILURE_COOLDOWN_MS) return true;
	if (!canCallExternalApis()) return true;
	const lastFetchAt = lastExternalFetch.get(service) || 0;
	return now - lastFetchAt < EXTERNAL_API_MIN_INTERVAL_MS;
}

export async function cachedFetch<T>(rawKey: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
	const key = normalizeKey(rawKey);
	const redis = getUpstash();

	if (redis) {
		try {
			const raw = await redis.get<string>(key);
			if (raw != null) return JSON.parse(raw) as T;
			const primed = await getPrimedCacheValue<T>(key);
			if (primed != null) {
				await setStringIfValid(key, JSON.stringify(primed), ttlSeconds);
				return primed;
			}
			const disk = await getDiskCacheValue<T>(key);
			if (disk != null) {
				await setStringIfValid(key, JSON.stringify(disk), ttlSeconds);
				return disk;
			}
		} catch {
			// fall through to in-memory cache / fetch
		}
	}

	const mem = getMem();
	const cached = memGet(mem, key);
	if (cached !== null) return cached as T;

	const primed = await getPrimedCacheValue<T>(key);
	if (primed != null) {
		memSet(mem, key, primed, ttlSeconds);
		return primed;
	}

	const diskValue = await getDiskCacheValue<T>(key);
	if (diskValue != null) {
		memSet(mem, key, diskValue, ttlSeconds);
		return diskValue;
	}

	const service = getExternalService(key);
	if (shouldSkipExternalFetch(service)) {
		return undefined as unknown as T;
	}

	try {
		const value = await fetcher();
		if (service) lastExternalFetch.set(service, Date.now());
		if (value !== undefined) {
			memSet(mem, key, value, ttlSeconds);
			if (redis) {
				try {
					// use centralized safe writer to avoid empty-hits and non-string collisions
					await setStringIfValid(key, JSON.stringify(value), ttlSeconds);
				} catch {
					// ignore redis write failures
				}
			}
		}
		return value;
	} catch (error) {
		if (service) lastExternalFailure.set(service, Date.now());
		return undefined as unknown as T;
	}
}
