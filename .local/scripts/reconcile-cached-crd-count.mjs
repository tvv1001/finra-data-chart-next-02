#!/usr/bin/env node
// Reconcile `dashboard:cached-crd-count` with the real number of cached CRDs.
//
// The app maintains this key with INCRBY (see incrementInventoryCounterInRedis in
// src/app/api/dashboard/refresh/route.ts), never with a recount, so it drifts whenever
// CRDs land outside the dashboard ingest path (bulk imports, direct writes). It only
// self-heals when missing or 0, so a stale non-zero value stays stale forever.
//
// This script counts unique CRDs in LOCAL Redis (the source of truth for local work)
// and writes that number to the chosen target.
//
// Usage:
//   node .local/scripts/reconcile-cached-crd-count.mjs                      # dry run, local count only
//   node .local/scripts/reconcile-cached-crd-count.mjs --apply              # write to LOCAL redis
//   node .local/scripts/reconcile-cached-crd-count.mjs --target=prod        # dry run against prod
//   node .local/scripts/reconcile-cached-crd-count.mjs --target=prod --apply --yes
//
// Safety: dry run by default. Writing to prod requires BOTH --apply and --yes, and never
// runs a KEYS/SCAN against prod (it only GETs the single counter key for the before value).

import Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const COUNTER_KEY = 'dashboard:cached-crd-count';
const LOCAL_REDIS_URL = process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379';
const DETAIL_KEY_RE = /^(?:finra|sec):(?:individual|firm):(\d+)$/;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const confirmed = args.has('--yes');
const target = [...args].find((a) => a.startsWith('--target='))?.split('=')[1] || 'local';

if (!['local', 'prod', 'mirror', 'both'].includes(target)) {
	console.error(`Unknown --target=${target}. Use local | prod | mirror | both.`);
	process.exit(1);
}

// Plain node does not load .env.local, and dotenv is not a dependency here.
function loadLocalEnv() {
	try {
		const raw = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
		for (const line of raw.split('\n')) {
			const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
			if (!match) continue;
			const value = match[2].replace(/^["']|["']$/g, '');
			if (process.env[match[1]] === undefined) process.env[match[1]] = value;
		}
	} catch {
		/* no .env.local is fine */
	}
}

async function countLocalUniqueCrds() {
	const redis = new Redis(LOCAL_REDIS_URL, { maxRetriesPerRequest: 2 });
	const unique = new Set();
	const individuals = new Set();
	const firms = new Set();
	let cursor = '0';
	let scannedKeys = 0;
	do {
		// SCAN rather than KEYS so this stays safe to run against a live instance.
		const [next, batch] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 1000);
		cursor = next;
		for (const key of batch) {
			scannedKeys += 1;
			const match = key.match(DETAIL_KEY_RE);
			if (!match) continue;
			unique.add(match[1]);
			(key.includes(':individual:') ? individuals : firms).add(match[1]);
		}
	} while (cursor !== '0');
	redis.disconnect();
	return { unique: unique.size, individuals: individuals.size, firms: firms.size, scannedKeys };
}

async function upstashCommand(url, token, command) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(command),
	});
	if (!res.ok) throw new Error(`Upstash ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return (await res.json()).result;
}

function resolveTargets() {
	const targets = [];
	if (target === 'local') return [{ name: 'local', kind: 'local' }];
	const primary = { name: 'prod (DB1)', kind: 'upstash', url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
	const mirror = {
		name: 'prod (DB2 mirror)',
		kind: 'upstash',
		url: process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2,
		token: process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2,
	};
	if (target === 'prod' || target === 'both') targets.push(primary);
	if (target === 'mirror' || target === 'both') targets.push(mirror);
	return targets;
}

async function main() {
	loadLocalEnv();

	const counts = await countLocalUniqueCrds();
	console.log(`Local Redis (${LOCAL_REDIS_URL}): scanned ${counts.scannedKeys} keys`);
	console.log(`  unique individual CRDs: ${counts.individuals}`);
	console.log(`  unique firm CRDs:       ${counts.firms}`);
	console.log(`  unique CRDs total:      ${counts.unique}\n`);

	if (!counts.unique) {
		console.error('Refusing to continue: local Redis reported 0 cached CRDs.');
		process.exit(1);
	}

	const targets = resolveTargets();
	for (const entry of targets) {
		if (entry.kind === 'upstash' && (!entry.url || !entry.token)) {
			console.warn(`Skipping ${entry.name}: REST url/token not set in the environment.`);
			continue;
		}

		let before = null;
		if (entry.kind === 'local') {
			const redis = new Redis(LOCAL_REDIS_URL, { maxRetriesPerRequest: 2 });
			before = await redis.get(COUNTER_KEY);
			if (apply) await redis.set(COUNTER_KEY, String(counts.unique));
			redis.disconnect();
		} else {
			before = await upstashCommand(entry.url, entry.token, ['GET', COUNTER_KEY]);
			if (apply && confirmed) await upstashCommand(entry.url, entry.token, ['SET', COUNTER_KEY, String(counts.unique)]);
		}

		const wrote = apply && (entry.kind === 'local' || confirmed);
		const suffix = wrote ? 'WROTE' : 'dry run, no write';
		console.log(`${entry.name}: ${COUNTER_KEY} ${before ?? '(unset)'} -> ${counts.unique}  [${suffix}]`);

		if (apply && entry.kind === 'upstash' && !confirmed) {
			console.log('  Add --yes to actually write to production.');
		}
	}

	if (!apply) console.log('\nDry run. Re-run with --apply (and --yes for prod) to write.');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
