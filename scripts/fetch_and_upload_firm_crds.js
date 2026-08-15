#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Redis = require('ioredis');

// Usage: node scripts/fetch_and_upload_firm_crds.js --firm 10111 [--concurrency 8]
const argv = require('minimist')(process.argv.slice(2));
const firmId = String(argv.firm || argv.f || '').trim();
if (!firmId) {
	console.error('Usage: --firm <firmId>');
	process.exit(2);
}
const CONCURRENCY = Number(argv.concurrency || 8);
const DATA_ROOT = path.join(process.cwd(), 'data', 'national');
const BROKER_DIR = path.join(DATA_ROOT, 'brokercheck.finra.org');
const SEC_DIR = path.join(DATA_ROOT, 'adviserinfo.sec.gov');
fs.mkdirSync(BROKER_DIR, { recursive: true });
fs.mkdirSync(SEC_DIR, { recursive: true });

const redis = new Redis('redis://127.0.0.1:6379');

function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

async function fetchJson(url) {
	try {
		const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'finra-data-batch/1.0' } });
		return res.data;
	} catch (err) {
		console.warn('fetch failed', url, err?.message || err);
		return null;
	}
}

function extractCrdsFromSearchPayload(payload) {
	if (!payload) return [];
	const hits = payload.hits?.hits || payload?.hits || [];
	const results = [];
	for (const h of hits) {
		const src = h?._source || h || {};
		const id = String(src.ind_source_id || src.ind_crd || src.individualId || src.id || src.crd || src.person_crd || '').trim();
		if (id && /^\d+$/.test(id)) results.push(id);
	}
	return Array.from(new Set(results));
}

async function fetchFirmLists(firmId) {
	const maxApiRows = 100;
	const finraUrl = `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&includePrevious=true&nrows=${maxApiRows}`;
	const secUrl = `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&includePrevious=true&nrows=${maxApiRows}`;

	const [finra, sec] = await Promise.all([fetchJson(finraUrl), fetchJson(secUrl)]);
	const finraCrds = extractCrdsFromSearchPayload(finra);
	const secCrds = extractCrdsFromSearchPayload(sec);
	const crds = Array.from(new Set([...finraCrds, ...secCrds]));
	return { finra, sec, crds };
}

function brokerFilenameForIndividual(crd) {
	return `api.brokercheck.finra.org_search_individual_${crd}.json`;
}
function secFilenameForIndividual(crd) {
	return `api.adviserinfo.sec.gov_search_individual_${crd}.json`;
}

async function fetchAndSaveIndividual(crd) {
	// FINRA individual detail
	const finraDetailUrl = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&wt=json&includePrevious=true&nrows=12`;
	const secDetailUrl = `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?hl=true&wt=json&includePrevious=true&nrows=12`;

	const finra = await fetchJson(finraDetailUrl);
	if (finra) {
		const outPath = path.join(BROKER_DIR, brokerFilenameForIndividual(crd));
		try {
			fs.writeFileSync(outPath, JSON.stringify(finra));
		} catch (e) {
			console.warn('write fail', outPath, e.message);
		}
		try {
			await redis.select(1);
			await redis.set(`finra:individual:${crd}`, JSON.stringify(finra));
		} catch (e) {
			console.warn('redis write finra failed', crd, e.message);
		}
		// also write a top-level finra-individual file for import_local_cache
		try {
			fs.writeFileSync(path.join(DATA_ROOT, `finra-individual-${crd}.json`), JSON.stringify(finra));
		} catch (e) {}
	}

	const sec = await fetchJson(secDetailUrl);
	if (sec) {
		const outPath = path.join(SEC_DIR, secFilenameForIndividual(crd));
		try {
			fs.writeFileSync(outPath, JSON.stringify(sec));
		} catch (e) {
			console.warn('write fail', outPath, e.message);
		}
		try {
			await redis.select(1);
			await redis.set(`sec:individual:${crd}`, JSON.stringify(sec));
		} catch (e) {
			console.warn('redis write sec failed', crd, e.message);
		}
		try {
			fs.writeFileSync(path.join(DATA_ROOT, `sec-individual-${crd}.json`), JSON.stringify(sec));
		} catch (e) {}
	}
}

async function runForFirm(firmId) {
	console.log('Fetching firm lists for', firmId);
	const { finra, sec, crds } = await fetchFirmLists(firmId);
	console.log(`Found ${crds.length} unique CRDs for firm ${firmId}`);
	if (crds.length === 0) return;

	// concurrency-controlled processing
	let idx = 0;
	async function worker() {
		while (true) {
			const i = idx++;
			if (i >= crds.length) break;
			const crd = crds[i];
			console.log(`(${i + 1}/${crds.length}) processing ${crd}`);
			await fetchAndSaveIndividual(crd);
			// polite pause
			await sleep(150);
		}
	}

	const workers = [];
	for (let i = 0; i < Math.max(1, CONCURRENCY); i++) workers.push(worker());
	await Promise.all(workers);
	console.log('Done fetching and uploading individuals for firm', firmId);
}

(async () => {
	try {
		await runForFirm(firmId);
		console.log('All completed');
		redis.disconnect();
	} catch (err) {
		console.error('Error', err);
		redis.disconnect();
		process.exit(1);
	}
})();
