/**
 * graphStore.ts – Module-level graph file cache and helper utilities.
 * Shared by /api/finra/graph, /expand, /nodes-by-ids, /graph-search, /graph-append
 */
import { readFile, writeFile, access, constants } from "node:fs/promises";
import { GRAPH_FILE } from "./constants";

export let _graphCache: any = null;

export async function getFullGraph() {
  if (_graphCache) return _graphCache;
  if (!(await graphFileExists())) {
    _graphCache = { nodes: [], links: [], meta: {} };
    return _graphCache;
  }
  const raw = await readFile(GRAPH_FILE, "utf-8");
  _graphCache = JSON.parse(raw);
  return _graphCache;
}

export function invalidateGraphCache() {
  _graphCache = null;
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
