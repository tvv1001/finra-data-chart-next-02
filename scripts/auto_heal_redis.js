#!/usr/bin/env node
const zlib = require('zlib');

function decompressIfBrotli(raw) {
	if (typeof raw !== 'string') return raw;
	if (raw.startsWith('br:')) {
		try {
			const buf = Buffer.from(raw.slice(3), 'base64');
			return zlib.brotliDecompressSync(buf).toString('utf8');
		} catch (e) {
			return null;
		}
	}
	return raw;
}

async function main() {
	if (process.env.USE_LOCAL_REDIS !== '1') {
		console.error('This script requires USE_LOCAL_REDIS=1 to connect to the local Redis.');
		process.exit(1);
	}
	let IORedis;
	try {
		IORedis = require('ioredis');
	} catch (e) {
		console.error('ioredis is required but not installed.');
		process.exit(1);
	}
	const redis = new IORedis('redis://127.0.0.1:6379');
	console.log('Connected to local redis');

	const keys = [];
	const stream = redis.scanStream({ match: 'finra:*', count: 1000 });
	for await (const ks of stream) keys.push(...ks);
	const stream2 = redis.scanStream({ match: 'sec:*', count: 1000 });
	for await (const ks of stream2) keys.push(...ks);
	console.log('Discovered', keys.length, 'keys');

	const malformed = [];
	for (const key of keys) {
		try {
			const raw = await redis.get(key);
			if (raw == null) continue;
			let text = raw;
			if (typeof text !== 'string') {
				try {
					text = JSON.stringify(text);
				} catch (e) {
					text = String(text);
				}
			}
			const dec = decompressIfBrotli(text);
			if (dec == null) {
				malformed.push({ key, reason: 'brotli-decompress-failed' });
				continue;
			}
			try {
				JSON.parse(dec);
			} catch (e) {
				malformed.push({ key, reason: 'invalid-json' });
			}
		} catch (e) {
			malformed.push({ key, reason: 'redis-error', error: String(e.message || e) });
		}
	}

	console.log('Malformed keys found:', malformed.length);
	if (malformed.length === 0) {
		console.log('No malformed keys. Proceeding to persist TTLs on all keys.');
	}

	const crdSet = new Set();
	for (const m of malformed) {
		console.log('Deleting', m.key, m.reason);
		try {
			await redis.del(m.key);
		} catch (e) {
			console.error('Failed to delete', m.key, e.message || e);
		}
		const m2 = m.key.match(/[:](?:firm|individual)[:](\d+)/);
		if (m2) crdSet.add(m2[1]);
	}

	// Persist all remaining keys (remove TTL)
	console.log('Persisting TTL (removing expiration) on all finra:* and sec:* keys...');
	let persisted = 0;
	for (const key of keys) {
		try {
			const res = await redis.persist(key);
			if (res === 1) persisted++;
		} catch (e) {
			// ignore
		}
	}
	console.log('Persisted (removed TTL) on', persisted, 'keys');

	if (crdSet.size > 0) {
		const crds = Array.from(crdSet);
		console.log('CRDs to refresh:', crds.join(','));
		console.log('You can POST to /api/dashboard/refresh with these CRDs to re-fetch payloads.');
		// print curl command suggestion
		console.log('\nSuggested command:');
		console.log(
			`curl -sS -X POST 'http://localhost:4444/api/dashboard/refresh' -H 'Content-Type: application/json' -d '{"action":"fetch-crds","crds":[${crds.map((c) => `"${c}"`).join(',')}],"includePayload":true}' | jq`,
		);
	} else {
		console.log('No CRDs to refresh. Done.');
	}

	await redis.quit();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
