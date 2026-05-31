/**
 * cache.ts – Simple TTL cache: Upstash Redis (HTTP/REST) when env vars are
 * present, plus file-based binary cache fallback under data/cache-binary.
 * Structured values are stored as gzipped JSON (base64 in Redis, .bin on disk)
 * so CRD detail payloads can be fully pre-cached without primed bundle lookups.
 */
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { gunzipOffload, gzipOffload } from './gzipWorker';
import { Redis } from '@upstash/redis';
import { DATA_DIR } from './constants';

type MemStore = Map<string, { value: unknown; expiresAt: number }>;
type BinaryCacheMeta = {
	expiresAt: number;
	kind?: 'buffer-v1' | 'json-gzip-v1';
	key?: string;
	updatedAt?: string;
	sourceRawFile?: string;
};

let upstash: Redis | null = null;
let memStore: MemStore | null = null;
const BINARY_CACHE_DIR = path.join(DATA_DIR, 'cache-binary');
const JSON_BINARY_PREFIX = 'gz:';

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';

// Rate-limit protections for external API fetches. Keys that begin with
// "finra:" or "sec:" will be rate-limited to at most one fetch per
// EXTERNAL_API_MIN_INTERVAL_MS (default 5s) to avoid getting blocked by
// upstream providers during aggressive crawling or high traffic.
const EXTERNAL_API_MIN_INTERVAL_MS = Number(process.env.EXTERNAL_API_MIN_INTERVAL_MS || 5000);
const lastExternalFetch = new Map<string, number>();
// When an external API call fails (network error, upstream 5xx, etc.) we
// back off for a longer cooldown to avoid repeated failing requests. Default
// cooldown is 10 minutes (600_000 ms) but can be overridden by
// EXTERNAL_API_FAILURE_COOLDOWN_MS.
const EXTERNAL_API_FAILURE_COOLDOWN_MS = Number(process.env.EXTERNAL_API_FAILURE_COOLDOWN_MS || 600_000);
const lastExternalFailure = new Map<string, number>();
// Runtime toggle to control whether external FINRA/SEC lookups are allowed.
// Behavior:
// - In production (NODE_ENV === 'production') external API calls are allowed
//   by default unless explicitly disabled via EXTERNAL_API_DISABLED or
//   DISABLE_EXTERNAL_API_CALLS.
// - In non-production environments external API calls are disabled by default
//   unless the ALLOW_EXTERNAL_API env var is set to 'true'. This prevents
//   accidental upstream requests during local development or CI runs.
// Backwards-compat flags EXTERNAL_API_DISABLED and DISABLE_EXTERNAL_API_CALLS
// still force-disable external requests when set to '1' or 'true'.
const explicitDisable = [process.env.EXTERNAL_API_DISABLED, process.env.DISABLE_EXTERNAL_API_CALLS]
	.map((v) => String(v || '').toLowerCase())
	.some((v) => v === '1' || v === 'true');
const explicitAllow = String(process.env.ALLOW_EXTERNAL_API || process.env.ENABLE_EXTERNAL_API || '').toLowerCase() === 'true';

const EXTERNAL_API_DISABLED = explicitDisable || (process.env.NODE_ENV !== 'production' && !explicitAllow);

/** Strip nrows from a cache key so keys are stable regardless of the nrows parameter.
 *  Cache keys have the form `prefix:crd:querystring` — we target the last segment. */
function normalizeKey(key: string): string {
	const lastColon = key.lastIndexOf(':');
	if (lastColon === -1) return key;
	const suffix = key.slice(lastColon + 1);
	if (!suffix.includes('=')) return key;
	const qs = new URLSearchParams(suffix);
	qs.delete('nrows');
	// Canonicalize parameter ordering so keys match regardless of original
	// querystring param order in upstream dumps or Redis exports.
	const entries: [string, string][] = [];
	for (const [k, v] of qs.entries()) entries.push([k, v]);
	entries.sort((a, b) => a[0].localeCompare(b[0]));
	const canonical = new URLSearchParams(entries as any).toString();
	return key.slice(0, lastColon + 1) + canonical;
}

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

async function readLocalCacheEntry(key: string): Promise<{ buffer: Buffer; meta: BinaryCacheMeta } | null> {
	const { dataPath, metaPath } = getBinaryFilePaths(key);
	try {
		await access(dataPath);
		await access(metaPath);
	} catch {
		return null;
	}

	try {
		const rawMeta = await readFile(metaPath, 'utf-8');
		const meta = JSON.parse(rawMeta) as BinaryCacheMeta;
		if (meta.expiresAt <= Date.now()) {
			await Promise.all([unlink(dataPath).catch(() => undefined), unlink(metaPath).catch(() => undefined)]);
			return null;
		}
		return { buffer: await readFile(dataPath), meta };
	} catch {
		return null;
	}
}

async function writeLocalCacheEntry(key: string, value: Buffer, meta: BinaryCacheMeta) {
	await ensureBinaryCacheDir();
	const { dataPath, metaPath } = getBinaryFilePaths(key);
	await Promise.all([writeFile(dataPath, value), writeFile(metaPath, JSON.stringify(meta), 'utf-8')]);
}

async function readBinaryCache(key: string): Promise<Buffer | null> {
	const entry = await readLocalCacheEntry(key);
	if (!entry) return null;
	if (entry.meta.kind && entry.meta.kind !== 'buffer-v1') return null;
	return entry.buffer;
}

async function writeBinaryCache(key: string, value: Buffer, ttlSeconds: number) {
	const expiresAt = Date.now() + ttlSeconds * 1000;
	await writeLocalCacheEntry(key, value, { expiresAt, kind: 'buffer-v1', key, updatedAt: new Date().toISOString() });
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
		await Promise.all([
			redis.set(key, value.toString('base64'), { ex: ttlSeconds }),
			redis.set(`${key}:meta`, JSON.stringify({ binary: true, kind: 'buffer-v1' }), { ex: ttlSeconds }),
		]);
	} catch {
		// ignore redis binary set errors
	}
}

async function gzipJsonToBase64(json: string): Promise<string> {
	try {
		return await gzipOffload(json);
	} catch {
		return gzipSync(Buffer.from(json, 'utf8')).toString('base64');
	}
}

async function gunzipBase64ToJson(base64: string): Promise<string> {
	try {
		return await gunzipOffload(base64);
	} catch {
		return gunzipSync(Buffer.from(base64, 'base64')).toString('utf8');
	}
}

async function readStructuredCache<T>(key: string): Promise<T | null> {
	const entry = await readLocalCacheEntry(key);
	if (!entry) return null;
	if (entry.meta.kind && entry.meta.kind !== 'json-gzip-v1') return null;
	try {
		const json = await gunzipBase64ToJson(entry.buffer.toString('base64'));
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

async function writeStructuredCache(key: string, value: unknown, ttlSeconds: number) {
	const json = JSON.stringify(value);
	const expiresAt = Date.now() + ttlSeconds * 1000;
	const gzBase64 = await gzipJsonToBase64(json);
	await writeLocalCacheEntry(key, Buffer.from(gzBase64, 'base64'), {
		expiresAt,
		kind: 'json-gzip-v1',
		key,
		updatedAt: new Date().toISOString(),
	});
}

async function getStructuredFromRedis<T>(key: string): Promise<T | null> {
	const redis = getUpstash();
	if (!redis) return null;
	try {
		const raw = await redis.get<string>(key);
		if (raw == null) return null;
		if (typeof raw === 'string' && raw.startsWith(JSON_BINARY_PREFIX)) {
			const json = await gunzipBase64ToJson(raw.slice(JSON_BINARY_PREFIX.length));
			return JSON.parse(json) as T;
		}
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function setStructuredInRedis(key: string, value: unknown, ttlSeconds: number): Promise<void> {
	const redis = getUpstash();
	if (!redis) return;
	try {
		const gzBase64 = await gzipJsonToBase64(JSON.stringify(value));
		await Promise.all([
			redis.set(key, `${JSON_BINARY_PREFIX}${gzBase64}`, { ex: ttlSeconds }),
			redis.set(`${key}:meta`, JSON.stringify({ binary: true, kind: 'json-gzip-v1' }), { ex: ttlSeconds }),
		]);
	} catch {
		try {
			await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
		} catch {
			// ignore redis structured set errors
		}
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
	if (localCached) {
		if (redis) await setBinaryInRedis(key, localCached, ttlSeconds);
		return localCached;
	}

	const value = toBuffer(await fetcher());
	if (redis) {
		await setBinaryInRedis(key, value, ttlSeconds);
	} else {
		await writeBinaryCache(key, value, ttlSeconds);
	}
	return value;
}

export async function cachedFetch<T>(rawKey: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
	const key = normalizeKey(rawKey);
	const redis = getUpstash();

	if (redis) {
		try {
			const cached = await getStructuredFromRedis<T>(key);
			if (cached != null) return cached;
		} catch {
			// fall through to local cache / in-memory on Redis errors
		}
	}

	const localCached = await readStructuredCache<T>(key);
	if (localCached != null) {
		if (redis) await setStructuredInRedis(key, localCached, ttlSeconds);
		memSet(getMem(), key, localCached, ttlSeconds);
		return localCached;
	}

	const mem = getMem();
	const hit = memGet(mem, key);
	if (hit !== null) return hit as T;

	// Rate-limit outbound external fetches for FINRA/SEC sources (in-memory path).
	const service =
		key.startsWith('finra:') ? 'finra'
		: key.startsWith('sec:') ? 'sec'
		: '';
	if (service) {
		const now = Date.now();
		const lastFail = lastExternalFailure.get(service) || 0;
		if (now - lastFail < EXTERNAL_API_FAILURE_COOLDOWN_MS) {
			console.warn(`External API recently failed; skipping fetch for service=${service} until cooldown`);
			return undefined as unknown as T;
		}
		if (EXTERNAL_API_DISABLED) {
			console.info(`External API disabled; skipping external fetch for service=${service} key=${key}`);
			return undefined as unknown as T;
		}
		const last = lastExternalFetch.get(service) || 0;
		if (now - last < EXTERNAL_API_MIN_INTERVAL_MS) {
			console.warn(`Rate-limited external fetch for service=${service} key=${key}`);
			return undefined as unknown as T;
		}
	}

	try {
		const value = await fetcher();
		if (service) lastExternalFetch.set(service, Date.now());
		if (value !== undefined) {
			memSet(mem, key, value, ttlSeconds);
			await writeStructuredCache(key, value, ttlSeconds).catch(() => undefined);
			if (redis) await setStructuredInRedis(key, value, ttlSeconds);
		}
		return value;
	} catch (err) {
		if (service) {
			lastExternalFailure.set(service, Date.now());
			console.warn(`External fetch failed for service=${service}; backing off for ${EXTERNAL_API_FAILURE_COOLDOWN_MS}ms`, err instanceof Error ? err.message : err);
		}
		return undefined as unknown as T;
	}
}

export async function clearCache(rawKey: string) {
	const key = normalizeKey(rawKey);
	const redis = getUpstash();
	if (redis) {
		try {
			await redis.del(key);
			await redis.del(`${key}:meta`).catch(() => undefined);
		} catch {
			// fall through to in-memory
		}
	}
	const { dataPath, metaPath } = getBinaryFilePaths(key);
	await Promise.all([unlink(dataPath).catch(() => undefined), unlink(metaPath).catch(() => undefined)]);
	return getMem().delete(key);
}
