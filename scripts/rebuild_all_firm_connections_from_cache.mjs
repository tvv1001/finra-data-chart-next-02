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

  // firmId -> { finra: {current:Set, previous:Set}, sec: {current:Set, previous:Set} }
  const firmIndex = new Map();
  function getBucket(firmId, source) {
    let entry = firmIndex.get(firmId);
    if (!entry) {
      entry = {
        finra: { current: new Set(), previous: new Set() },
        sec: { current: new Set(), previous: new Set() },
      };
      firmIndex.set(firmId, entry);
    }
    return entry[source];
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
        const currentSet = new Set(currentFirmIds);
        const previousSet = new Set(previousFirmIds);
        // A firm the person is CURRENTLY at should not also count as a "previous" firm here.
        for (const fid of currentSet) getBucket(fid, source).current.add(crd);
        for (const fid of previousSet) {
          if (!currentSet.has(fid)) getBucket(fid, source).previous.add(crd);
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

  // Also gather the set of firms that currently HAVE mirror keys, so we can clear out
  // any firm whose mirror data is now entirely unconfirmed (zero cache-confirmed CRDs).
  const existingFirmKeys = await redis.keys("*:firm:*_brokers:*");
  const existingFirmIds = new Set();
  for (const key of existingFirmKeys) {
    const m = key.match(
      /^(?:finra|sec):firm:(.+)_brokers:(?:current|previous)$/,
    );
    if (m) existingFirmIds.add(m[1]);
  }
  console.log(
    `Firms with existing broker-id-mirror keys: ${existingFirmIds.size}`,
  );

  const allFirmIds = new Set([...firmIndex.keys(), ...existingFirmIds]);
  console.log(
    `Total firms to reconcile (union of referenced + existing): ${allFirmIds.size}`,
  );

  if (DRY_RUN) {
    let totalCurrent = 0;
    let totalPrevious = 0;
    let firmsGainingConnections = 0;
    let firmsLosingAllConnections = 0;
    for (const firmId of allFirmIds) {
      const entry = firmIndex.get(firmId);
      const curCount = entry
        ? entry.finra.current.size + entry.sec.current.size
        : 0;
      const prevCount = entry
        ? entry.finra.previous.size + entry.sec.previous.size
        : 0;
      totalCurrent += curCount;
      totalPrevious += prevCount;
      if (curCount + prevCount > 0 && !existingFirmIds.has(firmId))
        firmsGainingConnections++;
      if (curCount + prevCount === 0 && existingFirmIds.has(firmId))
        firmsLosingAllConnections++;
    }
    console.log(
      `\n[DRY RUN] Would write ${totalCurrent} total current-connection entries and ${totalPrevious} total previous-connection entries across ${allFirmIds.size} firms.`,
    );
    console.log(
      `[DRY RUN] Firms newly confirmed (had no mirror key before): ${firmsGainingConnections}`,
    );
    console.log(
      `[DRY RUN] Firms losing ALL mirror data (had a key, zero cache-confirmed CRDs now): ${firmsLosingAllConnections}`,
    );
    console.log(`\nRe-run with --write to apply.`);
    await redis.quit();
    return;
  }

  // WRITE mode: replace every firm's mirror keys, batching pipeline writes.
  let firmsProcessed = 0;
  let keysWritten = 0;
  let keysDeleted = 0;
  const firmIdList = [...allFirmIds];
  const WRITE_BATCH = 300;
  for (let i = 0; i < firmIdList.length; i += WRITE_BATCH) {
    const batch = firmIdList.slice(i, i + WRITE_BATCH);
    const pipeline = redis.pipeline();
    for (const firmId of batch) {
      const entry = firmIndex.get(firmId) || {
        finra: { current: new Set(), previous: new Set() },
        sec: { current: new Set(), previous: new Set() },
      };
      for (const source of ["finra", "sec"]) {
        for (const suffix of ["current", "previous"]) {
          const key = `${source}:firm:${firmId}_brokers:${suffix}`;
          const arr = [...entry[source][suffix]];
          if (arr.length) {
            pipeline.set(key, compress(JSON.stringify(arr)));
            keysWritten++;
          } else {
            pipeline.del(key);
            keysDeleted++;
          }
        }
      }
      pipeline.del(`graph:firm-connections:v10:${firmId}`);
    }
    await pipeline.exec();
    firmsProcessed += batch.length;
    if (firmsProcessed % 3000 < WRITE_BATCH)
      console.log(`  wrote ${firmsProcessed}/${firmIdList.length} firms...`);
  }

  console.log(
    `\nDone. Firms processed: ${firmsProcessed}. Mirror keys set: ${keysWritten}. Mirror keys deleted (empty): ${keysDeleted}.`,
  );
  console.log(
    `All graph:firm-connections:v10:<id> cache keys for touched firms evicted — app will recompute on next request.`,
  );

  await redis.quit();
}

main().catch((err) => {
  console.error("rebuild_all_firm_connections_from_cache crashed:", err);
  process.exit(2);
});
