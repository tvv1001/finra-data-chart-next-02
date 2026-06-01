#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Redis } = require('@upstash/redis');
const msgpack = require('msgpack-lite');

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('UPSTASH env required');
		process.exit(1);
	}
	const r = new Redis({ url, token });
	const NATIONAL = path.join(process.cwd(), 'data', 'national');
	const primed = path.join(NATIONAL, 'primed-cache');
	const exists = await fs.stat(primed).catch(() => false);
	if (!exists) {
		console.log('no primed-cache dir');
		return;
	}
	const files = await fs.readdir(primed);
	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		const name = f.replace('.json', '');
		const p = path.join(primed, f);
		console.log('processing', name);
		const raw = await fs.readFile(p);
		const obj = JSON.parse(raw.toString('utf-8'));
		const buf = Buffer.from(msgpack.encode(obj));
		const gz = zlib.gzipSync(buf);
		// conservative chunk size to allow for base64 expansion and stay under Upstash REST limits
		const MAX = parseInt(process.env.MAX_CHUNK_BYTES || String(6 * 1024 * 1024));
		const parts = [];
		for (let i = 0; i < gz.length; i += MAX) parts.push(gz.slice(i, i + MAX));
		for (let i = 0; i < parts.length; i++) {
			const key = `finra:primed:${name}:part:${i}`;
			await r.set(key, parts[i].toString('base64'));
			console.log('wrote', key);
		}
		const manifest = { parts: parts.length, bytes: gz.length, method: 'msgpack+gzip', uploadedAt: new Date().toISOString() };
		await r.set(`finra:primed:${name}:manifest`, JSON.stringify(manifest));
		console.log('manifest', name, manifest);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
