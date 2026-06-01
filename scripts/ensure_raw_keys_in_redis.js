#!/usr/bin/env node
// Ensure that files in data/raw are present as keys in Redis (filename minus .json = key)
const fs = require('node:fs/promises');
const path = require('node:path');
const { Redis } = require('@upstash/redis');
const Bottleneck = require('bottleneck');

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'data', 'raw');
const TTL_SECONDS = 60 * 60 * 24; // 1 day
const REPORT_INTERVAL = 500;

function isEmptyHits(rawStr) {
	try {
		const obj = JSON.parse(rawStr);
		if (!obj || !obj.hits) return false;
		const h = obj.hits;
		const total = h.total;
		const totalVal = typeof total === 'number' ? total : total && total.value;
		return totalVal === 0 && Array.isArray(h.hits) && h.hits.length === 0;
	} catch (e) {
		return false;
	}
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('UPSTASH env vars required');
		process.exit(1);
	}
	const redis = new Redis({ url, token });
	const limiter = new Bottleneck({ maxConcurrent: 5, minTime: 50 });

	let processed = 0,
		written = 0,
		failed = 0,
		skipped = 0;

	const ents = await fs.readdir(RAW, { withFileTypes: true });
	for (const e of ents) {
		if (!e.isFile()) continue;
		if (!e.name.endsWith('.json')) continue;
		const fname = e.name;
		const key = fname.replace(/\.json$/i, '');
		const p = path.join(RAW, fname);
		try {
			const raw = await fs.readFile(p, 'utf-8');
			if (isEmptyHits(raw)) {
				console.log('SKIP_EMPTY_HITS_FILE', fname);
				skipped++;
				processed++;
				if (processed % REPORT_INTERVAL === 0) console.log(`progress processed=${processed} written=${written} failed=${failed} skipped=${skipped}`);
				continue;
			}
			// check existence
			limiter.schedule(async () => {
				try {
					const exists = await redis.get(key);
					if (exists) {
						processed++;
						if (processed % REPORT_INTERVAL === 0) console.log(`progress processed=${processed} written=${written} failed=${failed} skipped=${skipped}`);
						return;
					}
					await redis.set(key, raw, { ex: TTL_SECONDS });
					written++;
				} catch (err) {
					console.warn('SET_ERR', key, err?.message || err);
					failed++;
				}
				processed++;
				if (processed % REPORT_INTERVAL === 0) console.log(`progress processed=${processed} written=${written} failed=${failed} skipped=${skipped}`);
			});
		} catch (err) {
			console.warn('READ_ERR', p, err?.message || err);
			failed++;
			processed++;
		}
	}

	await limiter.stop({ dropWaitingJobs: false });
	console.log('done processed=', processed, 'written=', written, 'failed=', failed, 'skipped=', skipped);
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
