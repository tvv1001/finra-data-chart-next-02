#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { Redis } = require('@upstash/redis');

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('UPSTASH env required');
		process.exit(1);
	}
	const r = new Redis({ url, token });
	const outDir = path.join(process.cwd(), 'data', 'national');
	if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, `redis-dump-${Date.now()}.jsonl`);
	const out = fs.createWriteStream(outPath, { flags: 'w' });

	console.log('dumping to', outPath);

	let cursor = '0';
	let total = 0;
	const BATCH = 50;
	do {
		const res = await r.scan(cursor, { MATCH: '*', COUNT: 1000 });
		cursor = res[0];
		const keys = res[1] || [];
		for (let i = 0; i < keys.length; i += BATCH) {
			const chunk = keys.slice(i, i + BATCH);
			try {
				const vals = await r.mget(...chunk);
				for (let j = 0; j < chunk.length; j++) {
					const rec = { key: chunk[j], value: vals[j] };
					out.write(JSON.stringify(rec) + '\n');
					total++;
				}
			} catch (e) {
				console.error('mget error, falling back to single gets for chunk', e.message);
				for (const k of chunk) {
					try {
						const v = await r.get(k);
						out.write(JSON.stringify({ key: k, value: v }) + '\n');
						total++;
					} catch (ee) {
						console.error('get error', k, ee.message);
					}
				}
			}
		}
		console.log('scanned cursor', cursor, 'total so far', total);
	} while (cursor !== '0');

	out.end();
	console.log('done, total keys dumped', total, 'file:', outPath);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
