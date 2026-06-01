#!/usr/bin/env node
const { Redis } = require('@upstash/redis');

function getRedis() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('Missing UPSTASH env vars');
		process.exit(2);
	}
	return new Redis({ url, token });
}

async function scanCount(redis, match = '*') {
	let cursor = '0';
	let total = 0;
	try {
		do {
			// scan returns [cursor, keys]
			// use pipeline exec if available; here we call redis.scan
			// some clients return object; handle array
			// eslint-disable-next-line no-await-in-loop
			const res = await redis.scan(cursor, { MATCH: match, COUNT: 1000 });
			if (!res) break;
			// res may be [cursor, keys]
			if (Array.isArray(res)) {
				cursor = String(res[0]);
				const keys = res[1] || [];
				total += keys.length;
			} else if (res.cursor !== undefined) {
				cursor = String(res.cursor);
				total += (res.keys || []).length;
			} else {
				break;
			}
		} while (cursor !== '0');
	} catch (e) {
		console.error('scan failed:', e.message || e);
		return null;
	}
	return total;
}

async function main() {
	const redis = getRedis();
	// try dbsize
	try {
		const size = await redis.dbsize();
		console.log('dbsize:', size);
	} catch (e) {
		console.log('dbsize not supported or failed:', e.message || e);
	}

	const patterns = ['*', 'finra:*', 'sec:*', 'finra:graph*', 'finra-individual*'];
	for (const p of patterns) {
		const c = await scanCount(redis, p);
		if (c === null) {
			console.log(`scan for ${p} failed`);
		} else {
			console.log(`keys matching '${p}': ${c}`);
		}
	}
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
