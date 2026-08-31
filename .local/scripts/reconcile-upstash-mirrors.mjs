#!/usr/bin/env node
/**
 * Bidirectional missing-key sync between Upstash DB1 and DB2/MIRROR.
 *
 * Only copies keys that are absent on the destination (no overwrite).
 * Designed for the dual-DB read LB in src/lib/redisClient.ts so both
 * sides can serve hits without expensive null→fallback round trips.
 *
 * Usage:
 *   node --env-file=.env.local scripts/reconcile-upstash-mirrors.mjs [--dry-run] [--limit=N] [--prefix=firm-connections:]
 *
 * Env:
 *   UPSTASH_REDIS_REST_URL / _TOKEN
 *   UPSTASH_REDIS_REST_URL_MIRROR / _TOKEN_MIRROR
 */
import { Redis } from '@upstash/redis';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const prefixArg = args.find((a) => a.startsWith('--prefix='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const PREFIX = prefixArg ? prefixArg.split('=')[1] : '';

const url1 = process.env.UPSTASH_REDIS_REST_URL;
const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2;

if (!url1 || !token1 || !url2 || !token2) {
	console.error('Missing Upstash DB1/DB2 credentials in env');
	process.exit(1);
}

const db1 = new Redis({ url: url1, token: token1 });
const db2 = new Redis({ url: url2, token: token2 });

async function scanAll(redis, match = '*') {
	const keys = [];
	let cursor = '0';
	do {
		const res = await redis.scan(cursor, { match, count: 500 });
		cursor = String(res[0]);
		keys.push(...(res[1] || []));
	} while (cursor !== '0');
	return keys;
}

async function copyMissing(from, to, fromLabel, toLabel, missingKeys) {
	let copied = 0;
	let skipped = 0;
	let errors = 0;
	for (const key of missingKeys) {
		if (copied + skipped + errors >= LIMIT) break;
		try {
			const val = await from.get(key);
			if (val == null) {
				skipped += 1;
				continue;
			}
			if (dryRun) {
				copied += 1;
				if (copied <= 20 || copied % 500 === 0) console.log(`[dry-run] ${fromLabel} → ${toLabel}: ${key}`);
				continue;
			}
			// Preserve string payloads as-is (including br: compressed).
			await to.set(key, val);
			copied += 1;
			if (copied <= 20 || copied % 500 === 0) console.log(`copied ${fromLabel} → ${toLabel}: ${key} (${copied})`);
		} catch (err) {
			errors += 1;
			console.warn(`error ${fromLabel} → ${toLabel} ${key}:`, err?.message || err);
		}
	}
	return { copied, skipped, errors };
}

async function main() {
	const match = PREFIX ? `${PREFIX}*` : '*';
	console.log(`Scanning keys (match=${match}) dryRun=${dryRun} limit=${Number.isFinite(LIMIT) ? LIMIT : '∞'}…`);
	const [keys1, keys2, size1, size2] = await Promise.all([scanAll(db1, match), scanAll(db2, match), db1.dbsize(), db2.dbsize()]);
	const set1 = new Set(keys1);
	const set2 = new Set(keys2);
	const only1 = keys1.filter((k) => !set2.has(k));
	const only2 = keys2.filter((k) => !set1.has(k));
	console.log(
		JSON.stringify(
			{
				db1Host: String(url1).replace(/^https?:\/\//, '').split('/')[0],
				db2Host: String(url2).replace(/^https?:\/\//, '').split('/')[0],
				dbsize: { db1: size1, db2: size2 },
				scanned: { db1: keys1.length, db2: keys2.length },
				missingOnDb2: only1.length,
				missingOnDb1: only2.length,
			},
			null,
			2,
		),
	);

	const toDb2 = await copyMissing(db1, db2, 'DB1', 'DB2', only1);
	const toDb1 = await copyMissing(db2, db1, 'DB2', 'DB1', only2);
	const [size1b, size2b] = await Promise.all([db1.dbsize(), db2.dbsize()]);
	console.log(JSON.stringify({ toDb2, toDb1, dbsizeAfter: { db1: size1b, db2: size2b } }, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
