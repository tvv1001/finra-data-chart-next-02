import Bottleneck from 'bottleneck';
import { Redis } from '@upstash/redis';

export const DEFAULT_TTL_SECONDS = Number(process.env.REDIS_CACHE_TTL_SECONDS || 86400);

let client: Redis | null = null;
export function getRedisClient(): Redis | null {
	if (client) return client;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	client = new Redis({ url, token });
	return client;
}

const limiter = new Bottleneck({ maxConcurrent: 5, minTime: 50 });

export function isEmptyHitsObj(obj: any): boolean {
	if (!obj || !obj.hits) return false;
	const h = obj.hits;
	const total = h.total;
	const totalVal = typeof total === 'number' ? total : total && total.value;
	return totalVal === 0 && Array.isArray(h.hits) && h.hits.length === 0;
}

export async function setIfValid(
	key: string,
	value: unknown,
	ttlSeconds: number | null = DEFAULT_TTL_SECONDS,
): Promise<'written' | 'skipped-empty' | 'skipped-nonstring' | 'no-client' | 'error'> {
	try {
		if (isEmptyHitsObj(value)) return 'skipped-empty';
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

		const normalizedTtlSeconds = Number(ttlSeconds);
		await limiter.schedule(async () => {
			if (ttlSeconds == null || !Number.isFinite(normalizedTtlSeconds) || normalizedTtlSeconds <= 0) {
				await redis.set(key, JSON.stringify(value));
				return;
			}
			await redis.set(key, JSON.stringify(value), { ex: Math.floor(normalizedTtlSeconds) });
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
		const redis = getRedisClient();
		if (!redis) return 'no-client';
		let t = 'none';
		try {
			t = await redis.type(key);
		} catch {}
		if (t && t !== 'none' && t !== 'string') return 'skipped-nonstring';
		const normalizedTtlSeconds = Number(ttlSeconds);
		await limiter.schedule(async () => {
			if (ttlSeconds == null || !Number.isFinite(normalizedTtlSeconds) || normalizedTtlSeconds <= 0) {
				await redis.set(key, raw);
				return;
			}
			await redis.set(key, raw, { ex: Math.floor(normalizedTtlSeconds) });
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
