#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();
const PRIMED_CACHE_DIR = path.join(ROOT, 'data', 'national', 'primed-cache');
const BUNDLE_NAMES = ['finra-individual', 'sec-individual', 'finra-firm', 'sec-firm'];
const REDIS_KEY_PREFIX = 'primed:bundle:';

function isValidUpstashUrl(value) {
	return typeof value === 'string' && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes('...');
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
		process.exit(1);
	}
	if (!isValidUpstashUrl(url)) {
		console.error(`Invalid UPSTASH_REDIS_REST_URL: ${JSON.stringify(url)}. It must be a real Upstash HTTPS URL like https://<id>.upstash.io`);
		process.exit(1);
	}

	const redis = new Redis({ url, token });
	let uploaded = 0;
	for (const bundleName of BUNDLE_NAMES) {
		const binPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.bin`);
		const jsonPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.json`);
		if (await exists(binPath)) {
			const data = await fs.readFile(binPath);
			await redis.set(`${REDIS_KEY_PREFIX}${bundleName}`, data.toString('base64'));
			uploaded += 1;
			console.log(`Uploaded ${bundleName}.bin -> ${REDIS_KEY_PREFIX}${bundleName}`);
			continue;
		}
		if (await exists(jsonPath)) {
			const jsonText = await fs.readFile(jsonPath, 'utf-8');
			const zlib = require('node:zlib');
			const gz = zlib.gzipSync(Buffer.from(jsonText, 'utf-8'));
			await redis.set(`${REDIS_KEY_PREFIX}${bundleName}`, gz.toString('base64'));
			uploaded += 1;
			console.log(`Uploaded ${bundleName}.json (gzipped) -> ${REDIS_KEY_PREFIX}${bundleName}`);
			continue;
		}
		console.warn(`Missing bundle for ${bundleName}: neither ${binPath} nor ${jsonPath} found`);
	}

	console.log(`Deployed ${uploaded} primed bundle(s) to Redis`);
}

main().catch((error) => {
	console.error('deploy_primed_cache_to_redis failed:', error);
	process.exit(1);
});
