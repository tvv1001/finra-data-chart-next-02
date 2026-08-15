#!/usr/bin/env node
const zlib = require('zlib');
const http = require('http');

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

async function getRedis() {
	if (process.env.USE_LOCAL_REDIS !== '1') {
		console.error('continuous_heal requires USE_LOCAL_REDIS=1 to connect to local redis');
		process.exit(1);
	}
	try {
		const IORedis = require('ioredis');
		return new IORedis('redis://127.0.0.1:6379');
	} catch (e) {
		console.error('ioredis not installed:', e.message || e);
		process.exit(1);
	}
}

async function scanAndHeal(redis) {
	const keys = [];
	try {
		const stream = redis.scanStream({ match: 'finra:*', count: 1000 });
		for await (const ks of stream) keys.push(...ks);
		const stream2 = redis.scanStream({ match: 'sec:*', count: 1000 });
		for await (const ks of stream2) keys.push(...ks);
	} catch (e) {
		console.error('scan error', e.message || e);
		return;
	}
	if (!keys.length) return;
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

	if (malformed.length === 0) {
		console.log(new Date().toISOString(), 'No malformed keys found');
		return;
	}

	console.log(new Date().toISOString(), 'Malformed keys found:', malformed.length);
	const crdSet = new Set();
	for (const m of malformed) {
		try {
			await redis.del(m.key);
			console.log('Deleted', m.key, m.reason);
		} catch (e) {
			console.error('Failed to delete', m.key, e.message || e);
		}
		const m2 = m.key.match(/[:](?:firm|individual)[:](\d+)/);
		if (m2) crdSet.add(m2[1]);
	}

	// Persist remaining keys
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
		await triggerRefresh(crds);
	}
}

function triggerRefresh(crds) {
	return new Promise((resolve) => {
		const payload = JSON.stringify({ action: 'fetch-crds', crds, includePayload: true });
		const req = http.request(
			{
				hostname: '127.0.0.1',
				port: 4444,
				path: '/api/dashboard/refresh',
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
			},
			(res) => {
				let data = '';
				res.on('data', (c) => (data += c));
				res.on('end', () => {
					console.log('Refresh response status', res.statusCode);
					try {
						console.log('Refresh body:', JSON.parse(data));
					} catch (e) {
						console.log(data);
					}
					resolve();
				});
			},
		);
		req.on('error', (err) => {
			console.error('Refresh request failed', err.message || err);
			resolve();
		});
		req.write(payload);
		req.end();
	});
}

async function main() {
	const interval = Number(process.env.SCAN_INTERVAL_MS || 60000);
	const redis = await getRedis();
	console.log('Starting continuous heal loop. Interval (ms):', interval);
	// Run immediately then interval
	await scanAndHeal(redis);
	setInterval(() => scanAndHeal(redis).catch((e) => console.error(e)), interval);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
