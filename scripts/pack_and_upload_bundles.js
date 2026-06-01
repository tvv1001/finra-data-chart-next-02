#!/usr/bin/env node
/*
 * pack_and_upload_bundles.js
 * - Reads large artifacts (finra-graph.json, primed-cache/*.json)
 * - Optionally serialize with MessagePack, then gzip
 * - Chunk into parts under a max chunk size and upload to Upstash Redis
 * - Writes a manifest key with parts metadata and encoding
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Redis } = require('@upstash/redis');
const msgpack = require('msgpack-lite');

const ROOT = process.cwd();
const NATIONAL = path.join(ROOT, 'data', 'national');
// default chunk size in bytes (base64 expansion can increase payload); use 6MB to be conservative
const MAX_CHUNK = parseInt(process.env.MAX_CHUNK_BYTES || String(6 * 1024 * 1024)); // 6MB default

function chunkBuffer(buf, size) {
	const parts = [];
	for (let i = 0; i < buf.length; i += size) parts.push(buf.slice(i, i + size));
	return parts;
}

async function uploadParts(redis, baseKey, buf) {
	const parts = chunkBuffer(buf, MAX_CHUNK);
	for (let i = 0; i < parts.length; i++) {
		const key = `${baseKey}:part:${i}`;
		await redis.set(key, parts[i].toString('base64'));
	}
	const manifest = { parts: parts.length, bytes: buf.length, uploadedAt: new Date().toISOString() };
	await redis.set(`${baseKey}:manifest`, JSON.stringify(manifest));
	return manifest;
}

async function processFile(redis, filePath, keyBase, opts = { useMsgpack: false }) {
	const raw = await fs.readFile(filePath);
	let payloadBuf;
	if (opts.useMsgpack) {
		const obj = JSON.parse(raw.toString('utf-8'));
		payloadBuf = Buffer.from(msgpack.encode(obj));
	} else {
		payloadBuf = Buffer.from(raw);
	}
	const gz = zlib.gzipSync(payloadBuf);
	return await uploadParts(redis, keyBase, gz);
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error('UPSTASH env vars required');
	const useMsgpack = process.env.USE_MSGPACK === '1' || process.env.USE_MSGPACK === 'true';
	const redis = new Redis({ url, token });

	// graph
	const graphPath = path.join(NATIONAL, 'finra-graph.json');
	if (await fs.stat(graphPath).catch(() => false)) {
		console.log('processing graph', graphPath, 'useMsgpack=', useMsgpack);
		const manifest = await processFile(redis, graphPath, 'finra:graph', { useMsgpack });
		console.log('uploaded graph manifest', manifest);
	} else {
		console.log('no finra-graph.json at', graphPath);
	}

	// primed-cache files
	const primedDir = path.join(NATIONAL, 'primed-cache');
	if (await fs.stat(primedDir).catch(() => false)) {
		const files = await fs.readdir(primedDir);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			const name = f.replace('.json', '');
			const p = path.join(primedDir, f);
			console.log('processing primed bundle', name);
			const manifest = await processFile(redis, p, `finra:primed:${name}`, { useMsgpack });
			console.log('uploaded primed manifest', name, manifest);
		}
	} else {
		console.log('no primed-cache dir at', primedDir);
	}

	console.log('done');
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
