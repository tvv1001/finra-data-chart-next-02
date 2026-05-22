/**
 * cache.ts – Simple TTL cache: Upstash Redis (HTTP/REST) when env vars are
 * present, file-based binary cache fallback for local development, and
 * pre-primed JSON bundles (stored under data/national/primed-cache) when
 * available to populate Redis on cold starts and avoid first-request latency.
 */
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Redis } from '@upstash/redis';
import { DATA_DIR, PRIMED_CACHE_DIR } from './constants';

type MemStore = Map<string, { value: unknown; expiresAt: number }>;
type PrimedBundle = Record<string, unknown>;
type PrimedBundleName = 'finra-individual' | 'sec-individual' | 'finra-firm' | 'sec-firm';

let upstash: Redis | null = null;
let memStore: MemStore | null = null;
const primedBundleCache = new Map<PrimedBundleName, PrimedBundle | null>();
const BINARY_CACHE_DIR = path.join(DATA_DIR, 'cache-binary');

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';

/** Strip nrows from a cache key so keys are stable regardless of the nrows parameter.
 *  Cache keys have the form `prefix:crd:querystring` — we target the last segment. */
function normalizeKey(key: string): string {
	const lastColon = key.lastIndexOf(':');
	if (lastColon === -1) return key;
	const suffix = key.slice(lastColon + 1);
	if (!suffix.includes('=')) return key;
	const qs = new URLSearchParams(suffix);
	qs.delete('nrows');
	return key.slice(0, lastColon + 1) + qs.toString();
}

const primedBundleFiles: Record<PrimedBundleName, string> = {
	'finra-individual': path.join(PRIMED_CACHE_DIR, 'finra-individual.json'),
	'sec-individual': path.join(PRIMED_CACHE_DIR, 'sec-individual.json'),
	'finra-firm': path.join(PRIMED_CACHE_DIR, 'finra-firm.json'),
	'sec-firm': path.join(PRIMED_CACHE_DIR, 'sec-firm.json'),
};

function getUpstash(): Redis | null {
	if (upstash !== null) return upstash;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) upstash = new Redis({ url, token });
	return upstash;
}

function getMem(): MemStore {
	if (!memStore) memStore = new Map();
	return memStore;
}

function memSet(map: MemStore, key: string, value: unknown, ttlSeconds: number) {
	const expiresAt = Date.now() + ttlSeconds * 1000;
	map.set(key, { value, expiresAt });
	setTimeout(() => {
		const cur = map.get(key);
		if (cur && cur.expiresAt <= Date.now()) map.delete(key);
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

function getBinaryFilePaths(key: string) {
	const hash = crypto.createHash('sha256').update(key).digest('hex');
	return {
		dataPath: path.join(BINARY_CACHE_DIR, `${hash}.bin`),
		metaPath: path.join(BINARY_CACHE_DIR, `${hash}.json`),
	};
}

async function ensureBinaryCacheDir() {
	try {
		await mkdir(BINARY_CACHE_DIR, { recursive: true });
	} catch {
		// ignore
	}
}

async function readBinaryCache(key: string): Promise<Buffer | null> {
	const { dataPath, metaPath } = getBinaryFilePaths(key);
	try {
		await access(dataPath);
		await access(metaPath);
	} catch {
		return null;
	}

	try {
		const rawMeta = await readFile(metaPath, 'utf-8');
		const meta = JSON.parse(rawMeta) as { expiresAt: number };
		if (meta.expiresAt <= Date.now()) {
			await Promise.all([unlink(dataPath).catch(() => undefined), unlink(metaPath).catch(() => undefined)]);
			return null;
		}
		return await readFile(dataPath);
	} catch {
		return null;
	}
}

async function writeBinaryCache(key: string, value: Buffer, ttlSeconds: number) {
	await ensureBinaryCacheDir();
	const { dataPath, metaPath } = getBinaryFilePaths(key);
	const expiresAt = Date.now() + ttlSeconds * 1000;
	await Promise.all([writeFile(dataPath, value), writeFile(metaPath, JSON.stringify({ expiresAt }), 'utf-8')]);
}

function toBuffer(value: Buffer | Uint8Array | ArrayBuffer): Buffer {
	if (Buffer.isBuffer(value)) return value;
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return Buffer.from(value);
}

async function getBinaryFromRedis(key: string): Promise<Buffer | null> {
	const redis = getUpstash();
	if (!redis) return null;
	try {
		const raw = await redis.get<string>(key);
		if (raw == null) return null;
		return Buffer.from(raw, 'base64');
	} catch {
		return null;
	}
}

async function setBinaryInRedis(key: string, value: Buffer, ttlSeconds: number): Promise<void> {
	const redis = getUpstash();
	if (!redis) return;
	try {
		await redis.set(key, value.toString('base64'), { ex: ttlSeconds });
	} catch {
		// ignore redis binary set errors
	}
}

export async function cachedFetchBinary(rawKey: string, ttlSeconds: number, fetcher: () => Promise<Buffer | Uint8Array | ArrayBuffer>): Promise<Buffer> {
	const key = normalizeKey(rawKey);
	const redis = getUpstash();
	if (redis) {
		const cached = await getBinaryFromRedis(key);
		if (cached) return cached;
	}

	const localCached = await readBinaryCache(key);
	if (localCached) return localCached;

	const value = toBuffer(await fetcher());
	if (redis) {
		await setBinaryInRedis(key, value, ttlSeconds);
	} else {
		await writeBinaryCache(key, value, ttlSeconds);
	}
	return value;
}

async function loadPrimedBundle(name: PrimedBundleName): Promise<PrimedBundle | null> {
	if (primedBundleCache.has(name)) return primedBundleCache.get(name) ?? null;
	try {
		const raw = await readFile(primedBundleFiles[name], 'utf-8');
		const parsed = JSON.parse(raw) as PrimedBundle;
		primedBundleCache.set(name, parsed);
		return parsed;
	} catch {
		primedBundleCache.set(name, null);
		return null;
	}
}

function resolvePrimedBundleName(key: string): PrimedBundleName | null {
	const nk = normalizeKey(key);
	if (nk.startsWith('finra:individual:') && nk.endsWith(`:${DEFAULT_INDIVIDUAL_QUERY}`)) return 'finra-individual';
	if (nk.startsWith('sec:individual:') && nk.endsWith(`:${DEFAULT_INDIVIDUAL_QUERY}`)) return 'sec-individual';
	if (nk.startsWith('finra:firm:') && nk.endsWith(`:${DEFAULT_FIRM_QUERY}`)) return 'finra-firm';
	if (nk.startsWith('sec:firm:') && !nk.startsWith('sec:firm:summaryHtml:') && nk.split(':').length === 3) return 'sec-firm';
	return null;
}

async function getPrimedCacheValue<T>(key: string): Promise<T | null> {
	const nk = normalizeKey(key);
	const bundleName = resolvePrimedBundleName(nk);
	if (!bundleName) return null;
	const bundle = await loadPrimedBundle(bundleName);
	// try normalized key first, then original key (backwards compat with bundles built before normalization)
	if (bundle) {
		if (nk in bundle) return bundle[nk] as T;
		if (key in bundle) return bundle[key] as T;
	}
	return null;
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
				await redis.set(key, JSON.stringify(primed), { ex: ttlSeconds });
				return primed;
			}
			const value = await fetcher();
			if (value !== undefined) {
				await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
			}
			return value;
		} catch {
			// fall through to in-memory on Redis errors
		}
	}

	const mem = getMem();
	const hit = memGet(mem, key);
	if (hit !== null) return hit as T;
	const primed = await getPrimedCacheValue<T>(key);
	if (primed != null) {
		memSet(mem, key, primed, ttlSeconds);
		return primed;
	}

	const value = await fetcher();
	if (value !== undefined) memSet(mem, key, value, ttlSeconds);
	return value;
}

export async function clearCache(rawKey: string) {
	const key = normalizeKey(rawKey);
	const redis = getUpstash();
	if (redis) {
		try {
			return await redis.del(key);
		} catch {
			// fall through to in-memory
		}
	}
	return getMem().delete(key);
}
