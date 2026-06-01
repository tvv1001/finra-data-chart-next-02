/**
 * cache.ts – Simple TTL cache: Upstash Redis (HTTP/REST) when env vars are
 * present, file-based binary cache fallback for local development, and
 * pre-primed JSON bundles (stored under data/national/primed-cache) when
 * available to populate Redis on cold starts and avoid first-request latency.
 */
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { gunzipOffload } from './gzipWorker';
import { Redis } from '@upstash/redis';
import { setStringIfValid } from '@/lib/redisCache';
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
// Runtime toggle to completely disable external FINRA/SEC lookups when set to
// '1' or 'true' in the environment. Useful for offline/dev modes.
const EXTERNAL_API_DISABLED = String(process.env.EXTERNAL_API_DISABLED || '').toLowerCase() === '1' || String(process.env.EXTERNAL_API_DISABLED || '').toLowerCase() === 'true';

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

function getPrimedRedisKey(name: PrimedBundleName): string {
	return `primed:bundle:${name}`;
}

function getPrimedRedisMetaKey(name: PrimedBundleName): string {
	return `${getPrimedRedisKey(name)}:meta`;
}

function getPrimedRedisPartKey(name: PrimedBundleName, index: number): string {
	return `${getPrimedRedisKey(name)}:part:${index}`;
}

function normalizePrimedBundle(parsed: PrimedBundle): PrimedBundle {
	const normalized: PrimedBundle = {};
	for (const k of Object.keys(parsed)) {
		try {
			normalized[normalizeKey(k)] = parsed[k];
		} catch {
			normalized[k] = parsed[k];
		}
	}
	return normalized;
}

async function decodePrimedBundlePayload(raw: string): Promise<PrimedBundle | null> {
	try {
		const json = await gunzipOffload(raw);
		const parsed = JSON.parse(json) as PrimedBundle;
		return normalizePrimedBundle(parsed);
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

		return await decodePrimedBundlePayload(parts.join(''));
	} catch {
		return null;
	}
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
	// Prefer a gzipped binary bundle (.bin) for server-only primed caches. Fall back
	// to legacy JSON bundles for compatibility.
	const jsonPath = primedBundleFiles[name];
	const binPath = jsonPath.replace(/\.json$/, '.bin');
	try {
		// try binary first
		const rawBin = await readFile(binPath);
		try {
			const json = await gunzipOffload(rawBin.toString('base64'));
			const parsed = JSON.parse(json) as PrimedBundle;
			// Normalize keys in the primed bundle so lookups are robust to
			// differences in querystring parameter ordering (e.g. wt vs includePrevious).
			const normalized = normalizePrimedBundle(parsed);
			primedBundleCache.set(name, normalized);
			return normalized;
		} catch {
			// fall through to json
		}
	} catch {
		// ignore missing bin
	}
	try {
		const raw = await readFile(jsonPath, 'utf-8');
		const parsed = JSON.parse(raw) as PrimedBundle;
		const normalized = normalizePrimedBundle(parsed);
		primedBundleCache.set(name, normalized);
		return normalized;
	} catch {
		// Fall back to Redis-hosted primed bundles if local disk is unavailable.
		const redisBundle = await getPrimedBundleFromRedis(name);
		if (redisBundle) {
			primedBundleCache.set(name, redisBundle);
			return redisBundle;
		}
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
				await setStringIfValid(key, JSON.stringify(primed), ttlSeconds);
				return primed;
			}
			// Rate-limit outbound external fetches for FINRA/SEC sources.
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
					// Too soon to call the external API again — return undefined so callers
					// treat this as a cache miss without hammering the upstream service.
					console.warn(`Rate-limited external fetch for service=${service} key=${key}`);
					return undefined as unknown as T;
				}
			}

			try {
				const value = await fetcher();
				if (service) lastExternalFetch.set(service, Date.now());
				if (value !== undefined) {
					await setStringIfValid(key, JSON.stringify(value), ttlSeconds);
				}
				return value;
			} catch (err) {
				if (service) {
					lastExternalFailure.set(service, Date.now());
					console.warn(`External fetch failed for service=${service}; backing off for ${EXTERNAL_API_FAILURE_COOLDOWN_MS}ms`, err instanceof Error ? err.message : err);
				}
				return undefined as unknown as T;
			}
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
		if (value !== undefined) memSet(mem, key, value, ttlSeconds);
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
			return await redis.del(key);
		} catch {
			// fall through to in-memory
		}
	}
	return getMem().delete(key);
}

// Verify primed bundles exist at startup and warn if missing. This helps ensure
// production deployments include `data/national/primed-cache` so the server can
// serve primed data on cold start instead of repeatedly calling external APIs.
async function verifyPrimedBundles() {
	for (const name of Object.keys(primedBundleFiles) as Array<PrimedBundleName>) {
		const jsonPath = primedBundleFiles[name];
		const binPath = jsonPath.replace(/\.json$/, '.bin');
		try {
			await access(binPath);
			continue;
		} catch {
			// bin missing
		}
		try {
			await access(jsonPath);
			continue;
		} catch {
			// json missing
		}
		// Neither bin nor json present
		console.warn(`Primed cache missing for ${name}: neither ${binPath} nor ${jsonPath} found. Add primed bundles to data/national/primed-cache for faster cold-starts.`);
	}
}

// Run verification asynchronously on module load so server logs will show a
// reminder during startup. This is lightweight (only filesystem checks).
void verifyPrimedBundles();
