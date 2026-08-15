#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();

function loadEnv(filePath) {
	try {
		const content = require('fs').readFileSync(filePath, 'utf-8');
		const env = {};
		for (const line of content.split('\n')) {
			const match = line.match(/^([A-Z_0-9]+)\s*=\s*["']?([^"'\n]*)["']?/);
			if (match) env[match[1]] = match[2];
		}
		return env;
	} catch {
		return {};
	}
}

const envVars = {
	...process.env,
	...loadEnv(path.join(ROOT, '.env')),
	...loadEnv(path.join(ROOT, '.env.local')),
	...loadEnv(path.join(ROOT, '.env.production')),
};

const instances = [];
if (envVars.UPSTASH_REDIS_REST_URL && envVars.UPSTASH_REDIS_REST_TOKEN) {
	instances.push({
		name: 'Redis 1',
		redis: new Redis({ url: envVars.UPSTASH_REDIS_REST_URL, token: envVars.UPSTASH_REDIS_REST_TOKEN }),
	});
}
if (envVars.UPSTASH_REDIS_REST_URL_2 && envVars.UPSTASH_REDIS_REST_TOKEN__2) {
	instances.push({
		name: 'Redis 2',
		redis: new Redis({ url: envVars.UPSTASH_REDIS_REST_URL_2, token: envVars.UPSTASH_REDIS_REST_TOKEN__2 }),
	});
}

if (instances.length === 0) {
	console.error('No Upstash Redis instances found in environment variables.');
	process.exit(1);
}

const MAX_CHUNK_CHARS = 700000;

function chunkString(str, max) {
	const chunks = [];
	for (let i = 0; i < str.length; i += max) {
		chunks.push(str.slice(i, i + max));
	}
	return chunks;
}

async function uploadToRedis(key, data, metaKey = null, metaObj = null) {
	for (const { name, redis } of instances) {
		const pipeline = redis.pipeline();
		const chunks = chunkString(data, MAX_CHUNK_CHARS);
		
		if (chunks.length <= 1) {
			pipeline.set(key, chunks[0]);
			if (metaKey) pipeline.del(metaKey);
		} else {
			pipeline.del(key);
			for (let i = 0; i < chunks.length; i++) {
				pipeline.set(`${key}:part:${i}`, chunks[i]);
			}
			if (metaKey && metaObj) {
				metaObj.chunked = true;
				metaObj.chunks = chunks.length;
				metaObj.chunkChars = MAX_CHUNK_CHARS;
				pipeline.set(metaKey, JSON.stringify(metaObj));
			}
		}

		await pipeline.exec();
		console.log(`[${name}] Uploaded ${key} (${chunks.length} chunk(s))`);
	}
}

async function exists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function deployPrimedCache() {
	const dir = path.join(ROOT, 'data', 'national', 'primed-cache');
	if (!(await exists(dir))) return;
	const entries = await fs.readdir(dir);
	const bundleNames = entries
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.replace(/\.json$/i, ''))
		.filter((name) => !/(?:^|[-_.])(manifest|index|meta)$/i.test(name));

	for (const bundleName of bundleNames) {
		const jsonPath = path.join(dir, `${bundleName}.json`);
		const raw = await fs.readFile(jsonPath);
		const compressed = zlib.brotliCompressSync(raw);
		const payload = 'br:' + compressed.toString('base64');
		await uploadToRedis(`primed:bundle:${bundleName}`, payload, `primed:bundle:${bundleName}:meta`, {
			encoding: 'base64-brotli',
			updatedAt: new Date().toISOString()
		});
	}
}

async function deployGraph() {
	const graphPath = path.join(ROOT, 'data', 'national', 'finra-graph.json');
	if (!(await exists(graphPath))) return;
	const raw = await fs.readFile(graphPath);
	const compressed = zlib.brotliCompressSync(raw);
	const payload = 'br:' + compressed.toString('base64');
	await uploadToRedis('finra:graph', payload, 'finra:graph:manifest', {
		bytes: raw.length,
		encoding: 'base64-brotli',
		updatedAt: new Date().toISOString()
	});
}

async function deploySearchIndexes() {
	const dir = path.join(ROOT, 'public', 'search-indexes');
	if (!(await exists(dir))) return;
	const entries = await fs.readdir(dir);
	for (const name of entries) {
		if (!name.endsWith('.json.gz')) continue;
		const match = name.match(/search-index\.(\w+)\.(\w+)\.json\.gz/);
		if (!match) continue;
		const bucket = `${match[1]}:${match[2]}`;
		
		const gzData = await fs.readFile(path.join(dir, name));
		const rawJson = zlib.gunzipSync(gzData);
		const compressed = zlib.brotliCompressSync(rawJson);
		const payload = 'br:' + compressed.toString('base64');
		
		await uploadToRedis(`search:indexes:${bucket}`, payload, `search:indexes:${bucket}:meta`, {
			encoding: 'base64-brotli',
			updatedAt: new Date().toISOString()
		});
	}
}

async function main() {
	console.log('Deploying Primed Cache...');
	await deployPrimedCache();
	console.log('Deploying Graph...');
	await deployGraph();
	console.log('Deploying Search Indexes...');
	await deploySearchIndexes();
	console.log('All artifacts deployed to both instances via pipeline using Brotli compression!');
}

main().catch(console.error);
