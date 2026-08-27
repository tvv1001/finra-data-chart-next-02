import type { Redis } from '@upstash/redis';
import Bottleneck from 'bottleneck';
import { getRedisClientInstance } from '@/lib/redisClient';
import zlib from 'zlib';

export const DEFAULT_TTL_SECONDS = Number(process.env.REDIS_CACHE_TTL_SECONDS || 86400);

let client: Redis | null = null;
export function getRedisClient(): Redis | null {
	if (client) return client;
	// prefer MIRROR env var but allow legacy _2 names
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	client = getRedisClientInstance({ url, token });
	return client;
}

const limiter = new Bottleneck({ maxConcurrent: 1000, minTime: 1 });

export function isEmptyHitsObj(obj: any): boolean {
	if (!obj || !obj.hits) return false;
	const h = obj.hits;
	const total = h.total;
	const totalVal = typeof total === 'number' ? total : total && total.value;
	return totalVal === 0 && Array.isArray(h.hits) && h.hits.length === 0;
}

function isPlainNumericIdArray(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false;
	try {
		const parsed = JSON.parse(trimmed);
		return (
			Array.isArray(parsed) &&
			parsed.every((item) => {
				if (typeof item === 'number') return Number.isFinite(item);
				if (typeof item === 'string') return /^\d{1,10}$/.test(item.trim());
				return false;
			})
		);
	} catch {
		return false;
	}
}

export function compressPayload(value: string): string {
	if (isPlainNumericIdArray(value)) {
		return value;
	}
	try {
		if (value.length > 512) {
			return 'br:' + zlib.brotliCompressSync(Buffer.from(value)).toString('base64');
		}
	} catch {
		// fallback
	}
	return value;
}

export function decompressPayload(value: string): string {
	if (typeof value === 'string' && value.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(value.slice(3), 'base64')).toString('utf-8');
		} catch {
			return value;
		}
	}
	return value;
}

export async function setIfValid(
	key: string,
	value: unknown,
	ttlSeconds: number | null = DEFAULT_TTL_SECONDS,
): Promise<'written' | 'skipped-empty' | 'skipped-nonstring' | 'no-client' | 'error'> {
	try {
		if (isEmptyHitsObj(value)) return 'skipped-empty';
		// Safety: only allow writes when UPSTASH_ALLOW_WRITES=1 to avoid accidental
		// data deployments during code pushes (e.g., Vercel builds). When disabled,
		// behave as if no redis client is configured.
		if (String(process.env.UPSTASH_ALLOW_WRITES || '0') !== '1') {
			// eslint-disable-next-line no-console
			console.warn('Redis writes are disabled (set UPSTASH_ALLOW_WRITES=1 to enable)');
			return 'no-client';
		}
		const redis = getRedisClient();
		if (!redis) return 'no-client';

		// check type to avoid WRONGTYPE errors
		let t = 'none';
		try {
			t = await redis.type(key);
		} catch (e) {
			// continue and let set fail later
		}
		if (t && t !== 'none' && t !== 'string') return 'skipped-nonstring';

		await limiter.schedule(async () => {
			const finalValue = compressPayload(JSON.stringify(value));
			if (ttlSeconds) {
				await redis.set(key, finalValue, { ex: ttlSeconds });
			} else {
				await redis.set(key, finalValue);
			}
		});
		return 'written';
	} catch (e) {
		// swallow but signal error
		// eslint-disable-next-line no-console
		console.warn('redisCache.setIfValid error', e?.message || e);
		return 'error';
	}
}

export async function setStringIfValid(
	key: string,
	raw: string,
	ttlSeconds: number | null = DEFAULT_TTL_SECONDS,
): Promise<'written' | 'skipped-empty' | 'skipped-nonstring' | 'no-client' | 'error'> {
	try {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
		if (isEmptyHitsObj(parsed)) return 'skipped-empty';
		if (String(process.env.UPSTASH_ALLOW_WRITES || '0') !== '1') {
			// eslint-disable-next-line no-console
			console.warn('Redis writes are disabled (set UPSTASH_ALLOW_WRITES=1 to enable)');
			return 'no-client';
		}
		const redis = getRedisClient();
		if (!redis) return 'no-client';
		let t = 'none';
		try {
			t = await redis.type(key);
		} catch {}
		if (t && t !== 'none' && t !== 'string') return 'skipped-nonstring';
		await limiter.schedule(async () => {
			const finalValue = compressPayload(raw);
			if (ttlSeconds) {
				await redis.set(key, finalValue, { ex: ttlSeconds });
			} else {
				await redis.set(key, finalValue);
			}
		});
		return 'written';
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn('redisCache.setStringIfValid error', e?.message || e);
		return 'error';
	}
}

const redisCache = { setIfValid, setStringIfValid, isEmptyHitsObj };
export default redisCache;
