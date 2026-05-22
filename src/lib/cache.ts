/**
 * cache.ts – Simple TTL cache: Upstash Redis (HTTP/REST) when env vars are
 * present, in-memory Map fallback for local development. This variant uses
 * pre-primed JSON bundles (stored under data/national/primed-cache) when
 * available to populate Redis on cold starts and avoid first-request latency.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import { PRIMED_CACHE_DIR } from './constants';
import { fileCacheGet, fileCacheSet, fileCacheClearSync } from './file-cache';

type MemStore = Map<string, { value: unknown; expiresAt: number }>;
type PrimedBundle = Record<string, unknown>;
type PrimedBundleName = 'finra-individual' | 'sec-individual' | 'finra-firm' | 'sec-firm';

let upstash: Redis | null = null;
let memStore: MemStore | null = null;
const primedBundleCache = new Map<PrimedBundleName, PrimedBundle | null>();

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

	// If not using Upstash, prefer a filesystem-backed cache during local development
	if (process.env.NODE_ENV === 'development') {
		try {
			const fileHit = await fileCacheGet<T>(key);
			if (fileHit !== null) return fileHit as T;

			const primed = await getPrimedCacheValue<T>(key);
			if (primed != null) {
				await fileCacheSet(key, primed, ttlSeconds * 1000);
				return primed;
			}

			const value = await fetcher();
			if (value !== undefined) await fileCacheSet(key, value, ttlSeconds * 1000);
			return value;
		} catch (err) {
			// on any file-cache error, fall back to in-memory
			console.warn('file-cache error, falling back to in-memory', err);
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
	if (process.env.NODE_ENV === 'development') {
		try {
			fileCacheClearSync();
			return true;
		} catch (err) {
			// fallback
		}
	}
	return getMem().delete(key);
}
