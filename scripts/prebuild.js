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

function runPrimedCacheBuild() {
	execSync('node scripts/build_primed_cache_bundle.js', {
		stdio: 'inherit',
		env: {
			...process.env,
			ENABLE_PRIMED_CACHE: 'true',
		},
	});
}

function hasLocalGraphArtifact() {
	const graphFile = path.join(process.cwd(), 'data', 'national', 'finra-graph.json');
	return hasJsonFiles(path.dirname(graphFile)) && fs.existsSync(graphFile);
}

function ensureLocalGraphArtifact(reason) {
	if (hasLocalGraphArtifact()) {
		console.log(`Using existing local graph artifact (${reason}).`);
		return;
	}

	console.warn(`No local finra-graph.json available (${reason}); rebuilding graph from local cache instead.`);
	execSync('node scripts/build_graph_from_cache.js --employment-scope all --no-redis', {
		stdio: 'inherit',
	});
}

function shouldSkipRemoteGraphSync() {
	if (process.env.VERCEL) return true;
	const explicitUrl = String(process.env.FINRA_LOCAL_URL || '').trim();
	const usingDefaultLocalhost = !explicitUrl || /^https?:\/\/localhost(?::\d+)?\/?$/i.test(explicitUrl);
	return Boolean(process.env.CI) && usingDefaultLocalhost;
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
	if (shouldSkipRemoteGraphSync()) {
		console.log('Skipping remote graph sync and localhost fetch in this build environment.');
		ensureLocalGraphArtifact(process.env.VERCEL ? 'Vercel build' : 'CI build without FINRA_LOCAL_URL');
	} else {
		try {
			execSync('node scripts/ensure_remote_graph.js', {
				stdio: 'inherit',
			});
			execSync('node scripts/fetch_graph_from_server.js', {
				stdio: 'inherit',
			});
		} catch (error) {
			console.warn('Remote graph sync failed; falling back to local graph artifact handling.');
			ensureLocalGraphArtifact('remote graph sync failure');
		}
	}
	if (canRebuildSearchIndexes()) {
		execSync('node scripts/build_search_indexes.js', {
			stdio: 'inherit',
		});
		runPrimedCacheBuild();
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
	runPrimedCacheBuild();
} else {
	console.warn('Skipping search index rebuild because raw source caches are unavailable.');
}
