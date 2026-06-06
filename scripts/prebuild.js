#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

function hasJsonFiles(dirPath) {
	try {
		return fs.existsSync(dirPath) && fs.readdirSync(dirPath).some((entry) => entry.endsWith('.json'));
	} catch {
		return false;
	}
}

function canRebuildSearchIndexes() {
	const root = process.cwd();
	const finraDir = path.join(root, 'data', 'national', 'brokercheck.finra.org');
	const secDir = path.join(root, 'data', 'national', 'adviserinfo.sec.gov');
	return hasJsonFiles(finraDir) && hasJsonFiles(secDir);
}

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

function isValidUpstashUrl(value) {
	return typeof value === 'string' && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes('...');
}

if (url && token) {
	if (!isValidUpstashUrl(url)) {
		console.error(`Invalid UPSTASH_REDIS_REST_URL: ${JSON.stringify(url)}.\n` + 'It must be a real Upstash HTTPS URL like https://<id>.upstash.io');
		process.exit(1);
	}
	console.log('SKIPPING graph rebuild because remote Redis is configured');
	execSync('node scripts/build_workers.js', {
		stdio: 'inherit',
	});
	execSync('node scripts/ensure_remote_graph.js', {
		stdio: 'inherit',
	});
	if (canRebuildSearchIndexes()) {
		execSync('node scripts/build_search_indexes.js', {
			stdio: 'inherit',
		});
	} else {
		console.warn('Skipping search index rebuild because raw source caches are unavailable.');
	}
	process.exit(0);
}

execSync('node scripts/build_workers.js', {
	stdio: 'inherit',
});
execSync('node scripts/build_graph_from_cache.js --employment-scope all --no-redis', {
	stdio: 'inherit',
});

if (canRebuildSearchIndexes()) {
	execSync('node scripts/build_search_indexes.js', {
		stdio: 'inherit',
	});
} else {
	console.warn('Skipping search index rebuild because raw source caches are unavailable.');
}
