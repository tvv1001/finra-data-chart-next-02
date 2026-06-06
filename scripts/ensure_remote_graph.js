#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();
const GRAPH_FILE = path.join(ROOT, 'data', 'national', 'finra-graph.json');
const GRAPH_KEY = 'finra:graph';
const MANIFEST_KEY = 'finra:graph:manifest';
const MAX_CHUNK_BYTES = parseInt(process.env.MAX_CHUNK_BYTES || String(6 * 1024 * 1024), 10);

function getRedis() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in the environment');
	}
	return new Redis({ url, token });
}

function isSessionResetGraph(rawValue) {
	if (typeof rawValue !== 'string') return false;
	const trimmed = rawValue.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
	try {
		const parsed = JSON.parse(trimmed);
		const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0;
		const links = Array.isArray(parsed?.links) ? parsed.links.length : 0;
		return nodes === 0 && links === 0 && String(parsed?.meta?.sourceLabel || '').trim() === '(session reset)';
	} catch {
		return false;
	}
}

async function clearChunkedGraph(redis, manifest) {
	const partCount = Number(manifest?.parts || manifest?.chunks || 0);
	for (let index = 0; index < partCount; index += 1) {
		await redis.del(`${GRAPH_KEY}:part:${index}`);
	}
	await redis.del(MANIFEST_KEY);
}

async function uploadGraph(redis) {
	if (!fs.existsSync(GRAPH_FILE)) {
		throw new Error(`Local graph file not found: ${GRAPH_FILE}`);
	}

	const rawGraph = fs.readFileSync(GRAPH_FILE, 'utf8');
	const parsedGraph = JSON.parse(rawGraph);
	const nodeCount = Array.isArray(parsedGraph?.nodes) ? parsedGraph.nodes.length : 0;
	if (nodeCount === 0) {
		throw new Error(`Refusing to upload empty local graph from ${GRAPH_FILE}`);
	}

	const gzipBase64 = zlib.gzipSync(Buffer.from(rawGraph, 'utf8')).toString('base64');
	const parts = [];
	for (let offset = 0; offset < gzipBase64.length; offset += MAX_CHUNK_BYTES) {
		parts.push(gzipBase64.slice(offset, offset + MAX_CHUNK_BYTES));
	}

	let existingManifest = null;
	try {
		const rawManifest = await redis.get(MANIFEST_KEY);
		if (typeof rawManifest === 'string' && rawManifest.trim()) {
			existingManifest = JSON.parse(rawManifest);
		} else if (rawManifest && typeof rawManifest === 'object') {
			existingManifest = rawManifest;
		}
	} catch {}

	await redis.del(GRAPH_KEY);
	if (existingManifest) await clearChunkedGraph(redis, existingManifest);

	for (let index = 0; index < parts.length; index += 1) {
		await redis.set(`${GRAPH_KEY}:part:${index}`, parts[index]);
	}

	const manifest = {
		parts: parts.length,
		chunks: parts.length,
		chunked: true,
		bytes: Buffer.byteLength(gzipBase64, 'utf8'),
		method: 'gzip+base64-json',
		uploadedAt: new Date().toISOString(),
	};
	await redis.set(MANIFEST_KEY, JSON.stringify(manifest));

	console.log(`Uploaded finra:graph as ${parts.length} chunk(s) from ${GRAPH_FILE}`);
}

async function main() {
	if (process.env.VERCEL) {
		console.log('Vercel build: skipping ensure_remote_graph.js.');
		return;
	}
	const redis = getRedis();
	const [rawGraph, rawManifest] = await Promise.all([redis.get(GRAPH_KEY), redis.get(MANIFEST_KEY)]);

	if (isSessionResetGraph(rawGraph)) {
		console.log('Remote finra:graph contains a session-reset placeholder; restoring it from the local graph.');
		await uploadGraph(redis);
		return;
	}

	if (rawGraph) {
		console.log('Remote finra:graph already exists; leaving it unchanged.');
		return;
	}

	if (rawManifest) {
		console.log('Remote finra:graph manifest already exists; leaving it unchanged.');
		return;
	}

	console.log('Remote finra:graph is missing; uploading the local graph.');
	await uploadGraph(redis);
}

main().catch((error) => {
	console.error(error?.message || error);
	process.exit(1);
});
