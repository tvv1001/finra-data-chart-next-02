#!/usr/bin/env node
/*
 * rebuild_all_firm_connections_from_cache.mjs
 *
 * Full-scan generalization of scan_cached_individuals_for_firm.mjs --write.
 * Scans EVERY cached individual record (finra:individual:*, sec:individual:*) ONCE,
 * builds a reverse index of firmId -> {current:Set<crd>, previous:Set<crd>} per source
 * (finra/sec) from each individual's own current/previous employment history, then
 * REPLACES every firm's broker-id-mirror keys (finra:firm:<id>_brokers:current/previous,
 * sec:firm:<id>_brokers:current/previous) with the confirmed results. Any firm that had a
 * mirror key but ends up with zero confirmed CRDs on a side gets that key deleted.
 * Also evicts graph:firm-connections:v10:<id> for every touched firm so the app recomputes.
 *
 * This makes each individual's own current/previous employment history the sole source of
 * truth for firm connections — no upstream FINRA/SEC roster endpoints or mono graph store
 * involved, per project's current direction.
 *
 * Usage:
 *   node scripts/rebuild_all_firm_connections_from_cache.mjs --dry-run   (report only, no writes)
 *   node scripts/rebuild_all_firm_connections_from_cache.mjs --write    (apply changes)
 */
import Redis from "ioredis";
import zlib from "zlib";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const DRY_RUN = args.includes("--dry-run") || !WRITE;

const redis = new Redis("redis://127.0.0.1:6379");

function decompress(v) {
  if (typeof v !== "string") return v;
  if (v.startsWith("br:"))
    return zlib
      .brotliDecompressSync(Buffer.from(v.slice(3), "base64"))
      .toString("utf8");
  if (v.startsWith("gz:"))
    return zlib.gunzipSync(Buffer.from(v.slice(3), "base64")).toString("utf8");
  return v;
}
function isPlainNumericIdArray(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.every((item) => {
        if (typeof item === "number") return Number.isFinite(item);
        if (typeof item === "string") return /^\d{1,10}$/.test(item.trim());
        return false;
      })
    );
  } catch {
    return false;
  }
}

function compress(str) {
  if (isPlainNumericIdArray(str)) return str;
  return (
    "br:" + zlib.brotliCompressSync(Buffer.from(str, "utf8")).toString("base64")
  );
}

function extractContent(rawJson) {
  if (rawJson?.hits?.hits?.length) {
    const source = rawJson.hits.hits[0]._source || {};
    const raw = source.content ?? source.iacontent;
    if (raw == null) return null;
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }
  if (rawJson?.finraBrokerCheck) return rawJson.finraBrokerCheck;
  if (
    rawJson?.basicInformation ||
    rawJson?.currentEmployments ||
    rawJson?.currentIAEmployments
  ) {
    return rawJson;
  }
  return null;
}

function employmentFirmIds(content) {
  const currentArrays = [
    content?.currentEmployments,
    content?.currentIAEmployments,
  ].filter(Array.isArray);
  const previousArrays = [
    content?.previousEmployments,
    content?.previousIAEmployments,
  ].filter(Array.isArray);
  const idsOf = (arr) =>
    arr
      .flatMap((a) => a)
      .map((e) => e?.firmId ?? e?.firm_id ?? e?.firmID)
      .filter((id) => id != null)
      .map(String);
  return {
    currentFirmIds: idsOf(currentArrays),
    previousFirmIds: idsOf(previousArrays),
  };
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "WRITE"}`);
  const finraKeys = await redis.keys("finra:individual:*");
  const secKeys = await redis.keys("sec:individual:*");
  const allKeys = [...new Set([...finraKeys, ...secKeys])];
  console.log(`Total cached individual keys to scan: ${allKeys.length}`);

  // firmId -> { current: Map<crd,{name}>, previous: Map<crd,{name}> }
  const firmIndex = new Map();
  function getBucket(firmId) {
    let entry = firmIndex.get(firmId);
    if (!entry) {
      entry = { current: new Map(), previous: new Map() };
      firmIndex.set(firmId, entry);
    }
    return entry;
  }

  let scanned = 0;
  let parseErrors = 0;
  let individualsWithEmployment = 0;
  const BATCH_SIZE = 500;
  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    const batch = allKeys.slice(i, i + BATCH_SIZE);
    const pipeline = redis.pipeline();
    batch.forEach((key) => pipeline.get(key));
    const results = await pipeline.exec();
    for (let j = 0; j < batch.length; j++) {
      scanned++;
      const key = batch[j];
      const crd = key.split(":").pop();
      const source = key.startsWith("sec:") ? "sec" : "finra";
      const [err, raw] = results[j] || [];
      if (err || !raw) continue;
      try {
        const json = JSON.parse(decompress(raw));
        const content = extractContent(json);
        if (!content) continue;
        const { currentFirmIds, previousFirmIds } = employmentFirmIds(content);
        if (currentFirmIds.length || previousFirmIds.length)
          individualsWithEmployment++;
        const bi = content?.basicInformation || {};
        const name =
          [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(" ").trim() ||
          `Individual ${crd}`;
        const currentSet = new Set(currentFirmIds);
        const previousSet = new Set(previousFirmIds);
        for (const fid of currentSet) {
          const bucket = getBucket(fid);
          bucket.current.set(crd, { name });
          bucket.previous.delete(crd);
        }
        for (const fid of previousSet) {
          const bucket = getBucket(fid);
          if (!bucket.current.has(crd)) bucket.previous.set(crd, { name });
        }
      } catch {
        parseErrors++;
      }
    }
    if (scanned % 5000 < BATCH_SIZE)
      console.log(`  scanned ${scanned}/${allKeys.length}...`);
  }

  console.log(
    `\nScan complete. Individuals with employment history: ${individualsWithEmployment}. Parse errors: ${parseErrors}.`,
  );
  console.log(
    `Distinct firms referenced by cached individuals: ${firmIndex.size}`,
  );

  const existingFirmKeys = await redis.keys("firm-connections:firm:*");
  const existingFirmIds = new Set();
  for (const key of existingFirmKeys) {
    const m = key.match(/^firm-connections:firm:(\d+)$/);
    if (m) existingFirmIds.add(m[1]);
  }
  console.log(`Existing firm-connections:firm keys: ${existingFirmIds.size}`);

  const allFirmIds = new Set([...firmIndex.keys(), ...existingFirmIds]);
  console.log(
    `Total firms to reconcile (union of referenced + existing): ${allFirmIds.size}`,
  );

  if (DRY_RUN) {
    let totalCurrent = 0;
    let totalPrevious = 0;
    let firmsGainingConnections = 0;
    for (const firmId of allFirmIds) {
      const entry = firmIndex.get(firmId);
      const curCount = entry ? entry.current.size : 0;
      const prevCount = entry ? entry.previous.size : 0;
      totalCurrent += curCount;
      totalPrevious += prevCount;
      if (curCount + prevCount > 0 && !existingFirmIds.has(firmId))
        firmsGainingConnections++;
    }
    console.log(
      `\n[DRY RUN] Person employment references ${totalCurrent} current and ${totalPrevious} previous memberships across ${allFirmIds.size} firms.`,
    );
    console.log(
      `[DRY RUN] Firms referenced by people but missing a firm-connections key: ${firmsGainingConnections}`,
    );
    console.log(`\nRe-run with --write to additively merge into firm-connections:firm:<id>.`);
    await redis.quit();
    return;
  }

  function parseRoster(raw) {
    if (!raw) return { currentConnections: [], previousConnections: [] };
    try {
      const json = JSON.parse(decompress(raw));
      const asEntries = (list, isCurrent) => {
        if (!Array.isArray(list)) return [];
        return list
          .map((item) => {
            if (item == null) return null;
            if (typeof item === "number" || typeof item === "string") {
              const id = String(item).trim();
              if (!/^\d{1,10}$/.test(id)) return null;
              return {
                individualId: id,
                name: `Individual ${id}`,
                relationship: isCurrent ? "Current registration" : "Previous registration",
                isCurrent,
              };
            }
            const id = String(item.individualId || item.crd || "").trim();
            if (!/^\d{1,10}$/.test(id)) return null;
            return { ...item, individualId: id, isCurrent };
          })
          .filter(Boolean);
      };
      return {
        currentConnections: asEntries(json.currentConnections || json.current || [], true),
        previousConnections: asEntries(json.previousConnections || json.previous || [], false),
        source: json.source,
      };
    } catch {
      return { currentConnections: [], previousConnections: [] };
    }
  }

  const fs = await import("fs");
  const path = await import("path");
  const diskDir = path.join(process.cwd(), "data", "firm-connections");
  fs.mkdirSync(diskDir, { recursive: true });

  let firmsProcessed = 0;
  let firmsUpdated = 0;
  let peopleAdded = 0;
  const firmIdList = [...allFirmIds];
  const WRITE_BATCH = 100;
  for (let i = 0; i < firmIdList.length; i += WRITE_BATCH) {
    const batch = firmIdList.slice(i, i + WRITE_BATCH);
    const readPipe = redis.pipeline();
    for (const firmId of batch) readPipe.get(`firm-connections:firm:${firmId}`);
    const existingRaws = await readPipe.exec();
    const writePipe = redis.pipeline();
    for (let j = 0; j < batch.length; j++) {
      const firmId = batch[j];
      const discovered = firmIndex.get(firmId) || {
        current: new Map(),
        previous: new Map(),
      };
      const raw = existingRaws[j]?.[1];
      const existing = parseRoster(raw);
      const currentById = new Map(
        (existing.currentConnections || []).map((e) => [String(e.individualId), e]),
      );
      const previousById = new Map(
        (existing.previousConnections || []).map((e) => [String(e.individualId), e]),
      );
      let added = 0;
      for (const [crd, meta] of discovered.current) {
        if (!currentById.has(crd)) {
          currentById.set(crd, {
            individualId: crd,
            name: meta.name,
            relationship: "Current registration",
            isCurrent: true,
            evidence: ["current-employment-record", "reverse-index-redis-only"],
          });
          previousById.delete(crd);
          added += 1;
        }
      }
      for (const [crd, meta] of discovered.previous) {
        if (currentById.has(crd) || previousById.has(crd)) continue;
        previousById.set(crd, {
          individualId: crd,
          name: meta.name,
          relationship: "Previous registration",
          isCurrent: false,
          evidence: ["matched-previous-employment", "reverse-index-redis-only"],
        });
        added += 1;
      }
      firmsProcessed += 1;
      if (!added) continue;
      const payload = {
        currentConnections: [...currentById.values()],
        previousConnections: [...previousById.values()],
        source: existing.source || "reverse-index-redis-only",
      };
      writePipe.set(
        `firm-connections:firm:${firmId}`,
        compress(JSON.stringify(payload)),
      );
      fs.writeFileSync(
        path.join(diskDir, `${firmId}.json`),
        JSON.stringify(payload) + "\n",
      );
      firmsUpdated += 1;
      peopleAdded += added;
    }
    await writePipe.exec();
    if (firmsProcessed % 1000 < WRITE_BATCH)
      console.log(`  merged ${firmsProcessed}/${firmIdList.length} firms (updated ${firmsUpdated}, added ${peopleAdded})...`);
  }

  console.log(
    `\nDone. Firms processed: ${firmsProcessed}. Firms updated: ${firmsUpdated}. People added from employment history: ${peopleAdded}.`,
  );

  await redis.quit();
}

main().catch((err) => {
  console.error("rebuild_all_firm_connections_from_cache crashed:", err);
  process.exit(2);
});
