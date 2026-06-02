#!/usr/bin/env node
const { execSync } = require('child_process');

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
	execSync('node scripts/build_workers.js && node scripts/build_search_indexes.js', {
		stdio: 'inherit',
	});
	process.exit(0);
}

execSync('node scripts/build_workers.js && node scripts/build_graph_from_cache.js --employment-scope all --no-redis && node scripts/build_search_indexes.js', {
	stdio: 'inherit',
});
