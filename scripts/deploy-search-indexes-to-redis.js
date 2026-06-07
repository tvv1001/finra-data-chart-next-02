#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');

function loadEnv(filePath) {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const env = {};
		for (const line of content.split('\n')) {
			const match = line.match(/^([A-Z_]+)\s*=\s*["']?([^"'\n]*)["']?/);
			if (match) env[match[1]] = match[2];
		}
		return env;
	} catch {
		return {};
	}
}

function isValidUpstashUrl(value) {
	return typeof value === 'string' && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes('...');
}

const envVars = {
	...loadEnv(path.join(root, '.env')),
	...loadEnv(path.join(root, '.env.production')),
};
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || envVars.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || envVars.UPSTASH_REDIS_REST_TOKEN;

if (!redisUrl || !redisToken) {
	console.warn('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set. Skipping Redis deployment.');
	process.exit(0);
}

if (!isValidUpstashUrl(redisUrl)) {
	console.error(`Invalid UPSTASH_REDIS_REST_URL: ${JSON.stringify(redisUrl)}. It must be a real Upstash HTTPS URL like https://<id>.upstash.io`);
	process.exit(1);
}

const indexes = [
	'search-index.finra.individual.json',
	'search-index.finra.firm.json',
	'search-index.sec.individual.json',
	'search-index.sec.firm.json',
];
const MAX_CHUNK_CHARS = Number(process.env.SEARCH_INDEX_REDIS_CHUNK_CHARS || 700_000);

function readIndexJson(fileName) {
	const jsonPath = path.join(root, 'data', 'national', fileName);
	if (fs.existsSync(jsonPath)) {
		return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
	}

	const gzPath = `${jsonPath}.gz`;
	if (fs.existsSync(gzPath)) {
		return JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf-8'));
	}

	throw new Error(`Missing ${jsonPath}(.gz)`);
}

async function deploySearchIndexToRedis(fileName) {
	try {
		const json = readIndexJson(fileName);
		const match = fileName.match(/search-index\.(\w+)\.(\w+)\.json/);
		if (!match) throw new Error(`Could not parse bucket from ${fileName}`);

		const bucket = `${match[1]}:${match[2]}`;
		const redisKey = `search:indexes:${bucket}`;
		const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(json), 'utf-8')).toString('base64');
		const chunks = [];
		for (let index = 0; index < encoded.length; index += MAX_CHUNK_CHARS) {
			chunks.push(encoded.slice(index, index + MAX_CHUNK_CHARS));
		}

		async function send(command) {
			const response = await fetch(redisUrl, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${redisToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(command),
			});
			if (!response.ok) {
				throw new Error(await response.text());
			}
			return response.json();
		}

		if (chunks.length === 1) {
			await send(['SET', redisKey, chunks[0]]);
			await send(['DEL', `${redisKey}:meta`]);
			console.log(`Uploaded ${fileName} to Redis (${redisKey})`);
			return true;
		}

		await send(['DEL', redisKey]);
		for (let index = 0; index < chunks.length; index += 1) {
			await send(['SET', `${redisKey}:part:${index}`, chunks[index]]);
		}
		await send([
			'SET',
			`${redisKey}:meta`,
			JSON.stringify({
				encoding: 'base64-gzip',
				chunked: true,
				chunks: chunks.length,
				chunkChars: MAX_CHUNK_CHARS,
				updatedAt: new Date().toISOString(),
			}),
		]);

		console.log(`Uploaded ${fileName} to Redis (${redisKey}) in ${chunks.length} chunk(s)`);
		return true;
	} catch (err) {
		console.error(`Failed to upload ${fileName}:`, err instanceof Error ? err.message : String(err));
		return false;
	}
}

async function main() {
	console.log('Deploying search indexes to Upstash Redis...');
	const results = await Promise.all(indexes.map(deploySearchIndexToRedis));
	const succeeded = results.filter(Boolean).length;
	console.log(`Successfully deployed ${succeeded}/${indexes.length} search indexes to Redis.`);
	process.exit(succeeded === indexes.length ? 0 : 1);
}

main().catch((error) => {
	console.error('deploy-search-indexes-to-redis failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
