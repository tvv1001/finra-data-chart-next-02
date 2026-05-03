/**
 * graphStore.ts – Module-level graph file cache and helper utilities.
 * Shared by /api/finra/graph, /expand, /nodes-by-ids, /graph-search, /graph-append
 *
 * Cache strategy:
 *  – _graphCache is populated on first read and cleared by:
 *    a) chokidar file watcher (live rebuilds without restart)
 *    b) explicit invalidateGraphCache() calls from API routes
 *    c) TTL: max 5 minutes to avoid stale data if watcher misses an event
 */
import { readFile, writeFile, access, constants } from "node:fs/promises";
import { GRAPH_FILE } from "./constants";

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

export function invalidateGraphCache() {
  _graphCache = null;
  _graphCacheAt = 0;
}

export async function graphFileExists() {
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
