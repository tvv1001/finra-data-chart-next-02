/**
 * cache.ts – Simple TTL cache: Upstash Redis (HTTP/REST) when env vars are
 * present, in-memory Map fallback for local development.
 *
 * Required env vars (set in Vercel dashboard and .env.local for local dev):
 *   UPSTASH_REDIS_REST_URL   – e.g. https://<db>.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN – from the Upstash console
 */
import { setTimeout as delay } from "node:timers/promises";
import { Redis } from "@upstash/redis";

type MemStore = Map<string, { value: unknown; expiresAt: number }>;

let upstash: Redis | null = null;
let memStore: MemStore | null = null;

function getUpstash(): Redis | null {
  if (upstash !== null) return upstash;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    upstash = new Redis({ url, token });
  }
  return upstash;
}

function getMem(): MemStore {
  if (!memStore) memStore = new Map();
  return memStore;
}

function memSet(map: MemStore, key: string, value: unknown, ttlSeconds: number) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  map.set(key, { value, expiresAt });
  void delay(ttlSeconds * 1000).then(() => {
    const cur = map.get(key);
    if (cur && cur.expiresAt <= Date.now()) map.delete(key);
  });
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

export async function cachedFetch<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const redis = getUpstash();

  if (redis) {
    try {
      const raw = await redis.get<string>(key);
      if (raw != null) return JSON.parse(raw) as T;
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
  const value = await fetcher();
  if (value !== undefined) memSet(mem, key, value, ttlSeconds);
  return value;
}

export async function clearCache(key: string) {
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
