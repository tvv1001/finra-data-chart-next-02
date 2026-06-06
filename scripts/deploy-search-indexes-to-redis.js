#!/usr/bin/env node

/**
 * Deploy search indexes to Upstash Redis for production use on Vercel
 * Reads search-index.*.json files and uploads them to Redis under `search:indexes:*` keys
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(import.meta.url)
	.split('/')
	.slice(0, -1)
	.join('/');
const root = join(__dirname, '..');

// Parse .env file manually
function loadEnv(filePath) {
	try {
		const content = readFileSync(filePath, 'utf-8');
		const env = {};
		content.split('\n').forEach((line) => {
			const match = line.match(/^([A-Z_]+)\s*=\s*["']?([^"'\n]*)["']?/);
			if (match) {
				env[match[1]] = match[2];
			}
		});
		return env;
	} catch (err) {
		return {};
	}
}

const envVars = loadEnv(join(root, '.env'));
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || envVars.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || envVars.UPSTASH_REDIS_REST_TOKEN;

if (!redisUrl || !redisToken) {
	console.warn('⚠ UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set. Skipping Redis deployment.');
	process.exit(0);
}

const indexes = ['search-index.finra.individual.json', 'search-index.finra.firm.json', 'search-index.sec.individual.json', 'search-index.sec.firm.json'];

async function deploySearchIndexToRedis(fileName) {
	const filePath = join(root, 'data', 'national', fileName);

	try {
		const data = readFileSync(filePath, 'utf-8');
		const json = JSON.parse(data);

		// Extract bucket name from filename (e.g., search-index.finra.individual.json -> finra:individual)
		const match = fileName.match(/search-index\.(\w+)\.(\w+)\.json/);
		if (!match) {
			console.warn(`⚠ Could not parse bucket from ${fileName}`);
			return false;
		}

		const bucket = `${match[1]}:${match[2]}`;
		const redisKey = `search:indexes:${bucket}`;

		// Upload to Redis using REST API
		const response = await fetch(redisUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${redisToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(['SET', redisKey, JSON.stringify(json)]),
		});

		if (!response.ok) {
			const error = await response.text();
			console.error(`✗ Failed to upload ${fileName} to Redis:`, error);
			return false;
		}

		const result = await response.json();
		console.log(`✓ Uploaded ${fileName} to Redis (${redisKey})`);
		return true;
	} catch (err) {
		console.error(`✗ Error uploading ${fileName}:`, err.message);
		return false;
	}
}

async function main() {
	console.log('Deploying search indexes to Upstash Redis...');

	const results = await Promise.all(indexes.map(deploySearchIndexToRedis));
	const succeeded = results.filter(Boolean).length;

	console.log(`\n✓ Successfully deployed ${succeeded}/${indexes.length} search indexes to Redis.`);

	if (succeeded === indexes.length) {
		process.exit(0);
	} else {
		process.exit(1);
	}
}

main();
