#!/usr/bin/env node
// Scan Redis for keys with empty search hits and delete them
const { Redis } = require('@upstash/redis');
const Bottleneck = require('bottleneck');

function isEmptyHitsObj(obj) {
	if (!obj || !obj.hits) return false;
	const h = obj.hits;
	const total = h.total;
	const totalVal = typeof total === 'number' ? total : total && total.value;
	return totalVal === 0 && Array.isArray(h.hits) && h.hits.length === 0;
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

	let cursor = '0';
	let scanned = 0;
	let deleted = 0;
	let nonString = 0;

	console.log('Scanning Redis for empty search hits (pattern finra:*)');
	do {
		// eslint-disable-next-line no-await-in-loop
		const res = await redis.scan(cursor, { MATCH: 'finra:*', COUNT: 1000 });
		if (!res) break;
		if (Array.isArray(res)) {
			cursor = String(res[0]);
			const keys = res[1] || [];
			for (const k of keys) {
				// schedule GET + check + DEL
				limiter.schedule(async () => {
					try {
						// check type first to avoid WRONGTYPE on non-string keys
						const t = await redis.type(k);
						scanned++;
						if (scanned % 1000 === 0) console.log('scanned=', scanned, 'deleted=', deleted, 'nonString=', nonString || 0);
						if (t !== 'string') {
							// non-string keys (list/hash/set/stream) - skip
							// we log a short warning so operator can inspect later
							console.warn('SKIP_NONSTRING', k, t);
							nonString = (nonString || 0) + 1;
							return;
						}
						const raw = await redis.get(k);
						if (!raw) return;
						let obj;
						try {
							obj = JSON.parse(raw);
						} catch (e) {
							return;
						}
						if (isEmptyHitsObj(obj)) {
							await redis.del(k);
							deleted++;
							console.log('DELETED_EMPTY', k);
						}
					} catch (e) {
						console.warn('ERR', k, e?.message || e);
					}
				});
			}
		} else if (res.cursor !== undefined) {
			cursor = String(res.cursor);
			const keys = res.keys || [];
			for (const k of keys) {
				limiter.schedule(async () => {
					try {
						const t = await redis.type(k);
						scanned++;
						if (scanned % 1000 === 0) console.log('scanned=', scanned, 'deleted=', deleted, 'nonString=', nonString || 0);
						if (t !== 'string') {
							console.warn('SKIP_NONSTRING', k, t);
							nonString = (nonString || 0) + 1;
							return;
						}
						const raw = await redis.get(k);
						if (!raw) return;
						let obj;
						try {
							obj = JSON.parse(raw);
						} catch (e) {
							return;
						}
						if (isEmptyHitsObj(obj)) {
							await redis.del(k);
							deleted++;
							console.log('DELETED_EMPTY', k);
						}
					} catch (e) {
						console.warn('ERR', k, e?.message || e);
					}
				});
			}
		} else {
			break;
		}
	} while (cursor !== '0');

	// wait for limiter
	await limiter.stop({ dropWaitingJobs: false });
	console.log('scan complete. scanned=', scanned, 'deleted=', deleted);
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
