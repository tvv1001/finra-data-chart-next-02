#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

function loadEnvFallback() {
	const envPath = path.resolve(process.cwd(), '.env.local');
	if (!fs.existsSync(envPath)) return;
	const raw = fs.readFileSync(envPath, 'utf8');
	for (const line of raw.split(/\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*))\s*$/i);
		if (m) {
			const k = m[1];
			const v = m[2] ?? m[3] ?? m[4] ?? '';
			if (!process.env[k]) process.env[k] = v;
		}
	}
}

loadEnvFallback();

const UPSTASH_ALLOW_WRITES = String(process.env.UPSTASH_ALLOW_WRITES || '0');
if (UPSTASH_ALLOW_WRITES !== '1') {
	console.error('UPSTASH_ALLOW_WRITES !== 1; aborting. Set UPSTASH_ALLOW_WRITES=1 in .env.local to permit writes.');
	process.exit(2);
}

const url1 = process.env.UPSTASH_REDIS_REST_URL;
const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2;

if (!url1 || !token1) {
	console.error('Primary Upstash config missing. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in env.');
	process.exit(3);
}

const primary = new Redis({ url: url1, token: token1 });
const mirror = url2 && token2 ? new Redis({ url: url2, token: token2 }) : null;

async function fetchSecFirm(crd) {
	const url = `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(crd)}?wt=json`;
	const res = await fetch(url).catch((e) => {
		throw e;
	});
	if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
	const json = await res.json();
	// SEC API wraps the payload in _source.iacontent (stringified JSON) in some responses
	const hit = json?.hits?.hits?.[0] || json?.hits?.hits?.[0] || (json?.hits && json.hits[0]);
	if (!hit) return json;
	const src = hit._source || hit._source || {};
	if (src.iacontent) {
		try {
			return JSON.parse(src.iacontent);
		} catch {
			return src.iacontent;
		}
	}
	return src;
}

async function main() {
	const crd = process.argv[2] || '149347';
	console.log('Fetching SEC firm payload for CRD', crd);
	const payload = await fetchSecFirm(crd).catch((e) => {
		console.error('fetch error', e?.message || e);
		process.exit(4);
	});

	const key = `sec:firm:${crd}`;
	const value = JSON.stringify(payload);

	console.log('Writing to primary Upstash:', key);
	await primary.set(key, value).catch((e) => {
		console.error('primary set error', e?.message || e);
		process.exit(5);
	});
	console.log('Primary write complete.');

	if (mirror) {
		console.log('Also writing to mirror Upstash:', key);
		await mirror.set(key, value).catch((e) => {
			console.error('mirror set error', e?.message || e);
		});
		console.log('Mirror write attempted.');
	}

	// Optionally save to data/national for local primed file
	const outDir = path.join(process.cwd(), 'data', 'national');
	try {
		if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
		const outPath = path.join(outDir, `api.adviserinfo.sec.gov_search_firm_${crd}.json`);
		fs.writeFileSync(outPath, value, 'utf8');
		console.log('Saved local primed file to', outPath);
	} catch (e) {
		console.error('Failed to write local file', e?.message || e);
	}

	console.log('Done.');
}

main().catch((e) => {
	console.error('Fatal:', e?.message || e);
	process.exit(1);
});
