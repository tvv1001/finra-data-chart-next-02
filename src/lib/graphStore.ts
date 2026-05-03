/**
 * graphStore.ts – Module-level graph file cache and helper utilities.
 * Shared by /api/finra/graph, /expand, /nodes-by-ids, /graph-search, /graph-append
 *
 * Persistence strategy:
 *  – On Vercel (UPSTASH_REDIS_REST_URL set): graph is stored in Upstash Redis
 *  – Locally (no env vars): graph is stored in data/national/finra-graph.json
 *
 * Cache strategy:
 *  – _graphCache is populated on first read and cleared by:
 *    a) chokidar file watcher (live rebuilds without restart, local only)
 *    b) explicit invalidateGraphCache() calls from API routes
 *    c) TTL: max 5 minutes to avoid stale data if watcher misses an event
 */
import { readFile, writeFile, access, mkdir, constants } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { GRAPH_FILE, SEED_PROFILES_FILE, SEEDS_FILE } from "./constants";

const REDIS_GRAPH_KEY = "finra:graph";

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
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min hard TTL

// ── Chokidar file watcher ────────────────────────────────────────────────────
// Only initialise in long-lived Node processes (not during `next build`).
if (process.env.NODE_ENV !== "test") {
  import("chokidar").then(({ default: chokidar }) => {
    chokidar
      .watch(GRAPH_FILE, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } })
      .on("change", () => { _graphCache = null; _graphCacheAt = 0; })
      .on("unlink", () => { _graphCache = null; _graphCacheAt = 0; });
  }).catch(() => { /* chokidar unavailable — fall back to TTL-only */ });
}

export async function getFullGraph() {
  const now = Date.now();
  if (_graphCache && now - _graphCacheAt < GRAPH_CACHE_TTL_MS) return _graphCache;
  if (_graphCache && now - _graphCacheAt >= GRAPH_CACHE_TTL_MS) _graphCache = null;

  const redis = getRedis();
  if (redis) {
    const raw = await redis.get<string>(REDIS_GRAPH_KEY);
    _graphCache = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : { nodes: [], links: [], meta: {} };
    _graphCacheAt = now;
    return _graphCache;
  }

  if (!(await graphFileExists())) {
    _graphCache = { nodes: [], links: [], meta: {} };
    _graphCacheAt = now;
    return _graphCache;
  }
  const raw = await readFile(GRAPH_FILE, "utf-8");
  _graphCache = JSON.parse(raw);
  _graphCacheAt = now;
  return _graphCache;
}

export async function saveGraph(data: any) {
  const redis = getRedis();
  if (redis) {
    await redis.set(REDIS_GRAPH_KEY, JSON.stringify(data));
  } else {
    await mkdir(path.dirname(GRAPH_FILE), { recursive: true });
    await writeFile(GRAPH_FILE, JSON.stringify(data, null, 2), "utf-8");
  }
  invalidateGraphCache();
}

export function invalidateGraphCache() {
  _graphCache = null;
  _graphCacheAt = 0;
}

export async function graphFileExists() {
  const redis = getRedis();
  if (redis) {
    const exists = await redis.exists(REDIS_GRAPH_KEY);
    return exists > 0;
  }
  try {
    await access(GRAPH_FILE, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// D3 simulation keys that should not be persisted to disk
const D3_SIM_KEYS = ["x", "y", "vx", "vy", "fx", "fy", "index"];

export function stripSimState(obj: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!D3_SIM_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

export function resolveId(ref: any): string | null {
  if (ref && typeof ref === "object") return ref.id ?? null;
  return ref ?? null;
}

// In-memory seed / profile caches
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

// ── Redis-backed profiles / seeds store ─────────────────────────────────────
const REDIS_PROFILES_KEY = "finra:seed-profiles";
const REDIS_SEEDS_KEY = "finra:seeds";

export async function getProfilesFromStore(): Promise<any> {
  const redis = getRedis();
  if (redis) {
    const raw = await redis.get<string>(REDIS_PROFILES_KEY);
    if (raw) return typeof raw === "string" ? JSON.parse(raw) : raw;
    // Bootstrap from filesystem if Redis has nothing yet
    try {
      const data = JSON.parse(await readFile(SEED_PROFILES_FILE, "utf-8"));
      await redis.set(REDIS_PROFILES_KEY, JSON.stringify(data));
      return data;
    } catch {
      return { profiles: [] };
    }
  }
  try {
    return JSON.parse(await readFile(SEED_PROFILES_FILE, "utf-8"));
  } catch {
    return { profiles: [] };
  }
}

export async function saveProfilesToStore(data: any): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(REDIS_PROFILES_KEY, JSON.stringify(data));
  } else {
    await writeFile(SEED_PROFILES_FILE, JSON.stringify(data, null, 2), "utf-8");
  }
  invalidateProfilesCache();
}

export async function getSeedsFromStore(): Promise<string[]> {
  const redis = getRedis();
  if (redis) {
    const raw = await redis.get<string>(REDIS_SEEDS_KEY);
    if (raw) return typeof raw === "string" ? JSON.parse(raw) : (raw as string[]);
    // Bootstrap from filesystem
    try {
      const data = JSON.parse(await readFile(SEEDS_FILE, "utf-8"));
      await redis.set(REDIS_SEEDS_KEY, JSON.stringify(data));
      return data;
    } catch {
      return [];
    }
  }
  try {
    return JSON.parse(await readFile(SEEDS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export async function saveSeedsToStore(seeds: string[]): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(REDIS_SEEDS_KEY, JSON.stringify(seeds));
  } else {
    await writeFile(SEEDS_FILE, JSON.stringify(seeds, null, 2), "utf-8");
  }
  invalidateSeedsCache();
}
