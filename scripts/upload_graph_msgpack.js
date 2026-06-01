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
	const graph = path.join(NATIONAL, 'finra-graph.json');
	if (!(await fs.stat(graph).catch(() => false))) {
		console.error('no graph file');
		process.exit(1);
	}
	const raw = await fs.readFile(graph);
	const obj = JSON.parse(raw.toString('utf-8'));
	const buf = Buffer.from(msgpack.encode(obj));
	const gz = zlib.gzipSync(buf);
	console.log('gz length', gz.length);
	// conservative chunk size to allow for base64 expansion
	const MAX = parseInt(process.env.MAX_CHUNK_BYTES || String(6 * 1024 * 1024));
	const parts = [];
	for (let i = 0; i < gz.length; i += MAX) parts.push(gz.slice(i, i + MAX));
	console.log('parts', parts.length);
	for (let i = 0; i < parts.length; i++) {
		const key = `finra:graph:part:${i}`;
		await r.set(key, parts[i].toString('base64'));
		console.log('wrote', key);
	}
	const manifest = { parts: parts.length, bytes: gz.length, method: 'msgpack+gzip', uploadedAt: new Date().toISOString() };
	await r.set('finra:graph:manifest', JSON.stringify(manifest));
	console.log('uploaded manifest', manifest);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
