#!/usr/bin/env node
// Set dashboard:cached-crd-count from data/raw scanning or write to Redis/local Redis
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'data', 'raw');
const KEY = 'dashboard:cached-crd-count';

function walk(dir, cb) {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, cb);
		else cb(full);
	}
}

function computeCounts() {
	const indiv = new Set();
	const firm = new Set();
	if (!fs.existsSync(RAW)) return { individuals: 0, firms: 0, total: 0 };
	walk(RAW, (file) => {
		const m1 = file.match(/search_individual_([0-9]+)\.json$/);
		if (m1) return indiv.add(m1[1]);
		const m2 = file.match(/search_firm_([0-9]+)\.json$/);
		if (m2) return firm.add(m2[1]);
		const m3 = file.match(/search_(?:individual|firm)_([0-9]+)\.json$/);
		if (m3) {
			// fallback
			indiv.add(m3[1]);
		}
	});
	const individuals = indiv.size;
	const firms = firm.size;
	const total = new Set([...indiv, ...firm]).size;
	return { individuals, firms, total };
}

async function writeToRedis(value) {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) {
		const { Redis } = require('@upstash/redis');
		const redis = new Redis({ url, token });
		await redis.set(KEY, String(value));
		console.log('WROTE (upstash):', KEY, value);
		return true;
	}

	if (process.env.USE_LOCAL_REDIS === '1') {
		const IORedis = require('ioredis');
		const r = new IORedis(process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379');
		await r.set(KEY, String(value));
		console.log('WROTE (local):', KEY, value);
		r.disconnect();
		return true;
	}

	return false;
}

async function main() {
	const counts = computeCounts();
	console.log('Computed counts from data/raw ->', counts);
	const val = counts.total;
	const ok = await writeToRedis(val);
	if (!ok) {
		console.log('No Redis credentials found. To write the value run:');
		console.log('  UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/set-dashboard-crd-count.js');
		console.log('OR for local Redis: USE_LOCAL_REDIS=1 node scripts/set-dashboard-crd-count.js');
		console.log('Value to set would be:', val);
		process.exit(2);
	}
}

main().catch((e) => {
	console.error('ERROR', e?.message || e);
	process.exit(3);
});
