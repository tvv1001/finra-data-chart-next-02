/**
 * cache.ts – Simple TTL cache: Redis when available, in-memory Map fallback.
 * Ported from server/services/finraCache.js
 */
import { setTimeout as delay } from "node:timers/promises";

let client: any = null;
let hasRedis = false;

async function tryInitRedis() {
  if (client !== null) return;
  try {
    const IORedis = (await import("ioredis")).default;
    const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
    client = new IORedis(url);
    await client.ping();
    hasRedis = true;
  } catch {
    hasRedis = false;
    client = new Map<string, { value: unknown; expiresAt: number }>();
  }
}

function memSet(map: Map<string, any>, key: string, value: unknown, ttlSeconds: number) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  map.set(key, { value, expiresAt });
  void delay(ttlSeconds * 1000).then(() => {
    const cur = map.get(key);
    if (cur && cur.expiresAt <= Date.now()) map.delete(key);
  });
}

function memGet(map: Map<string, any>, key: string) {
  const item = map.get(key);
  if (!item) return null;
  if (item.expiresAt && item.expiresAt <= Date.now()) {
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
  await tryInitRedis();

  if (hasRedis) {
    try {
      const raw = await client.get(key);
      if (raw) return JSON.parse(raw) as T;
      const value = await fetcher();
      if (value !== undefined) {
        await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
      }
      return value;
    } catch {
      // fall through to in-memory on Redis errors
    }
  }

  const mem = client as Map<string, any>;
  const hit = memGet(mem, key);
  if (hit) return hit as T;
  const value = await fetcher();
  if (value !== undefined) memSet(mem, key, value, ttlSeconds);
  return value;
}

export async function clearCache(key: string) {
  await tryInitRedis();
  if (hasRedis) return client.del(key);
  return (client as Map<string, any>).delete(key);
}
