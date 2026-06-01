#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { Redis } = require('@upstash/redis');

async function getSizeForType(r, t, k) {
	try {
		if (t === 'list' && typeof r.llen === 'function') return await r.llen(k);
		if (t === 'hash' && typeof r.hlen === 'function') return await r.hlen(k);
		if (t === 'set' && typeof r.scard === 'function') return await r.scard(k);
		if (t === 'zset' && typeof r.zcard === 'function') return await r.zcard(k);
		if (t === 'stream') {
			if (typeof r.xlen === 'function') return await r.xlen(k);
			// fallback: try XLEN command
			return await r.execute(['XLEN', k]);
		}
		return null;
	} catch (e) {
		return null;
	}
}

async function getSampleForType(r, t, k, size) {
	try {
		if (t === 'list' && typeof r.lrange === 'function') return await r.lrange(k, 0, Math.min(4, size - 1));
		if (t === 'set' && typeof r.srandmember === 'function') return await r.srandmember(k, Math.min(5, size));
		if (t === 'hash' && typeof r.hgetall === 'function') return await r.hgetall(k);
		if (t === 'zset' && typeof r.zrange === 'function') return await r.zrange(k, 0, Math.min(4, size - 1), 'WITHSCORES');
		return null;
	} catch (e) {
		return null;
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
	const outDir = path.join(process.cwd(), 'data', 'national');
	if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, `inspect-nonstring-finra-keys-${Date.now()}.jsonl`);
	const out = fs.createWriteStream(outPath, { flags: 'w' });

	console.log('inspecting non-string finra:* keys to', outPath);
	let cursor = '0';
	let scanned = 0;
	let found = 0;
	do {
		const res = await redis.scan(cursor, { MATCH: 'finra:*', COUNT: 1000 });
		if (!res) break;
		cursor = String(res[0]);
		const keys = res[1] || [];
		for (const k of keys) {
			scanned++;
			if (scanned % 1000 === 0) console.log('scanned=', scanned, 'found=', found);
			try {
				const t = await redis.type(k);
				if (t && t !== 'string') {
					const ttl = await redis.ttl(k);
					const size = await getSizeForType(redis, t, k);
					const sample = size ? await getSampleForType(redis, t, k, size) : null;
					const rec = { key: k, type: t, ttl, size, sample };
					out.write(JSON.stringify(rec) + '\n');
					found++;
				}
			} catch (e) {
				console.warn('ERR', k, e?.message || e);
			}
		}
	} while (cursor !== '0');

	out.end();
	console.log('inspect complete. scanned=', scanned, 'found=', found, 'file=', outPath);
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
