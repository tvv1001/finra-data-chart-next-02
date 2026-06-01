#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { Redis } = require('@upstash/redis');

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
	const outPath = path.join(outDir, `nonstring-finra-keys-${Date.now()}.jsonl`);
	const out = fs.createWriteStream(outPath, { flags: 'w' });

	console.log('scanning finra:* keys and reporting non-string types to', outPath);
	let cursor = '0';
	let scanned = 0;
	let found = 0;
	do {
		const res = await redis.scan(cursor, { MATCH: 'finra:*', COUNT: 1000 });
		if (!res) break;
		cursor = String(res[0]);
		const keys = res[1] || [];
		for (const k of keys) {
			try {
				scanned++;
				if (scanned % 1000 === 0) console.log('scanned=', scanned, 'found=', found);
				const t = await redis.type(k);
				if (t && t !== 'string') {
					const ttl = await redis.ttl(k);
					const rec = { key: k, type: t, ttl };
					out.write(JSON.stringify(rec) + '\n');
					found++;
				}
			} catch (e) {
				console.warn('ERR', k, e?.message || e);
			}
		}
	} while (cursor !== '0');

	out.end();
	console.log('scan complete. scanned=', scanned, 'non-string found=', found, 'file=', outPath);
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
