#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const argv = require('minimist')(process.argv.slice(2));

// Usage: node scripts/sync_local_db1_to_prod_db1.js --prodUrl redis://:pass@host:6379 [--dry-run]
// Or set PROD_REDIS_URL in .env and run without --prodUrl

try {
	// load .env then .env.local if present
	require('dotenv').config();
	const localPath = path.join(process.cwd(), '.env.local');
	if (fs.existsSync(localPath)) {
		const dotenv = require('dotenv');
		const parsed = dotenv.parse(fs.readFileSync(localPath));
		for (const k of Object.keys(parsed)) process.env[k] = parsed[k];
	}
} catch (e) {
	// dotenv not installed in this environment; ignore
}

const PROD_REDIS_URL = argv.prodUrl || process.env.PROD_REDIS_URL;
if (!PROD_REDIS_URL) {
	console.error('Missing production Redis URL. Provide --prodUrl or set PROD_REDIS_URL in .env');
	process.exit(2);
}

const DRY = Boolean(argv['dry-run'] || argv.dry);
const PREVIEW = Boolean(argv.preview || argv['dry-run-preview']);
const MAX_WRITES = Number(argv['max-writes'] || argv.maxWrites || 0); // stop if estimated writes exceed this
const ONLY_MISSING = Boolean(argv['only-missing'] || argv.onlyMissing);
const PREFIX = String(argv.prefix || argv.p || '').trim();
const PATTERN = String(argv.match || argv.pattern || '').trim();
const RATE = Number(argv.rate || argv.r || 0); // ops per second
const RATE_DELAY_MS = RATE > 0 ? Math.ceil(1000 / RATE) : Number(argv.delay || argv.rateDelay || 0);
const STATE_PATH = path.join(process.cwd(), 'tmp', 'sync_prod_state_db1.json');
fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });

const local = new Redis('redis://127.0.0.1:6379');
const prod = new Redis(PROD_REDIS_URL);

async function loadState() {
	try {
		return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	} catch (e) {
		return { cursor: '0', processed: 0, copied: 0, skipped: 0 };
	}
}

async function saveState(s) {
	fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function copyKey(key) {
	const t = await local.type(key);
	try {
		if (t === 'string') {
			const v = await local.get(key);
			if (DRY || PREVIEW) return { copied: true, key, estimated: 1 };
			await prod.set(key, v);
			await prod.persist(key).catch(() => {});
			return { copied: true, key };
		}
		if (t === 'hash') {
			const h = await local.hgetall(key);
			if (DRY) return { copied: true, key };
			const existsOnProd = await prod.exists(key);
			if (existsOnProd) {
				const ph = await prod.hgetall(key);
				// compare
				const same = Object.keys(h).length === Object.keys(ph).length && Object.keys(h).every((k) => String(h[k]) === String(ph[k]));
				if (same) return { skipped: true, key, reason: 'identical' };
				// compute diffs: fields to set and fields to delete
				const toSet = {};
				for (const k of Object.keys(h)) {
					if (String(h[k]) !== String(ph[k])) toSet[k] = h[k];
				}
				const toDelete = Object.keys(ph).filter((k) => !(k in h));
				if (Object.keys(toSet).length === 0 && toDelete.length === 0) return { skipped: true, key, reason: 'no-diff' };
				if (DRY || PREVIEW) {
					// estimate 1 write for hash diff
					return { copied: true, key, estimated: 1 };
				}
				if (toDelete.length) await prod.hdel(key, ...toDelete).catch(() => {});
				if (Object.keys(toSet).length) await prod.hmset(key, toSet).catch(() => {});
				await prod.persist(key).catch(() => {});
				return { copied: true, key };
			}
			// not on prod: create
			if (Object.keys(h).length === 0) {
				await prod.del(key);
			} else {
				await prod.hmset(key, h);
				await prod.persist(key).catch(() => {});
			}
			return { copied: true, key };
		}
		// for lists/sets/zsets we can avoid heavy DUMP if sizes match
		if (t === 'list' || t === 'set' || t === 'zset') {
			try {
				let localCount = 0;
				if (t === 'list') localCount = await local.llen(key);
				else if (t === 'set') localCount = await local.scard(key);
				else if (t === 'zset') localCount = await local.zcard(key);
				const prodCount =
					(await prod.exists(key)) ?
						t === 'list' ? await prod.llen(key)
						: t === 'set' ? await prod.scard(key)
						: await prod.zcard(key)
					:	-1;
				if (prodCount === localCount && prodCount >= 0) {
					return { skipped: true, key, reason: 'same-size' };
				}
			} catch (e) {
				// ignore and fall back to dump
			}
		}
		// fallback for lists, sets, zsets and other types using DUMP/RESTORE
		const dumped = await local.dump(key).catch(() => null);
		if (!dumped) return { skipped: true, key, reason: 'dump-failed' };
		const pttl = await local.pttl(key).catch(() => -1);
		const ttl = pttl > 0 ? pttl : 0;
		if (DRY || PREVIEW) return { copied: true, key, estimated: 1 };
		// RESTORE with REPLACE
		try {
			if (PREVIEW) return { copied: true, key, estimated: 1 };
			await prod.restore(key, ttl, dumped, 'REPLACE');
			// ensure persistence
			await prod.persist(key).catch(() => {});
			return { copied: true, key };
		} catch (e) {
			return { skipped: true, key, reason: e.message };
		}
	} catch (e) {
		return { skipped: true, key, reason: e.message };
	}
}

async function main() {
	console.log('Sync local Redis DB1 -> PROD DB1', DRY ? '(dry-run)' : '');
	const state = await loadState();
	let cursor = state.cursor || '0';
	let processed = state.processed || 0;
	let copied = state.copied || 0;
	let skipped = state.skipped || 0;

	// ensure both select DB1
	await local.select(1);
	// await prod.select(1); // Upstash only supports DB0

	do {
		const scanArgs = [cursor, 'COUNT', 1000];
		if (PREFIX) scanArgs.push('MATCH', `${PREFIX}*`);
		else if (PATTERN) scanArgs.push('MATCH', PATTERN);
		const res = await local.scan(...scanArgs);
		cursor = res[0];
		const keys = res[1];
		for (const key of keys) {
			processed++;
			// allow restricting to only-missing keys (avoid touching existing ones)
			if (ONLY_MISSING) {
				const exists = await prod.exists(key);
				if (exists) {
					skipped++;
					continue;
				}
			}
			// skip some ephemeral keys if desired
			if (key.startsWith('temp:') || key.startsWith('cache:')) {
				skipped++;
				continue;
			}
			const resKey = await copyKey(key);
			if (resKey.copied) {
				if (typeof resKey.estimated === 'number') copied += resKey.estimated;
				else copied++;
			} else skipped++;

			// stop early if estimated writes would exceed MAX_WRITES
			if (MAX_WRITES > 0 && copied > MAX_WRITES) {
				state.cursor = cursor;
				state.processed = processed;
				state.copied = copied;
				state.skipped = skipped;
				await saveState(state);
				console.log('Stopped: estimated writes exceeded MAX_WRITES', MAX_WRITES);
				local.disconnect();
				prod.disconnect();
				return;
			}

			// rate limit writes (delay after each action)
			if (RATE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, RATE_DELAY_MS));

			// persist occasional state to allow resume
			if (processed % 500 === 0) {
				state.cursor = cursor;
				state.processed = processed;
				state.copied = copied;
				state.skipped = skipped;
				await saveState(state);
				console.log('progress saved', state);
			}
		}
	} while (cursor !== '0');

	state.cursor = '0';
	state.processed = processed;
	state.copied = copied;
	state.skipped = skipped;
	await saveState(state);
	console.log('Done. processed=', processed, 'copied=', copied, 'skipped=', skipped);

	local.disconnect();
	prod.disconnect();
}

main().catch((err) => {
	console.error('Fatal', (err && err.message) || err);
	process.exit(1);
});
