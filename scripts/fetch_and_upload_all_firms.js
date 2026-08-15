#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Redis = require('ioredis');
const argv = require('minimist')(process.argv.slice(2));

// Usage: node scripts/fetch_and_upload_all_firms.js [--concurrency 4] [--perFirmConcurrency 6] [--limit N] [--firms-file file]
// By default this will discover firms from data/firm-connections and data/national and process them all.

const CONCURRENCY = Number(argv.concurrency || 4);
const PER_FIRM_CONCURRENCY = Number(argv.perFirmConcurrency || argv.perFirmConcurrency || 6);
const LIMIT = argv.limit ? Number(argv.limit) : Infinity; // optional limit for quick runs
const FIRMS_FILE = argv['firms-file'] || argv.firmsFile || '';

const ROOT = process.cwd();
const DATA_ROOT = path.join(ROOT, 'data', 'national');
const BROKER_DIR = path.join(DATA_ROOT, 'brokercheck.finra.org');
const SEC_DIR = path.join(DATA_ROOT, 'adviserinfo.sec.gov');
const FIRM_CONN_DIR = path.join(ROOT, 'data', 'firm-connections');
fs.mkdirSync(BROKER_DIR, { recursive: true });
fs.mkdirSync(SEC_DIR, { recursive: true });

const redis = new Redis('redis://127.0.0.1:6379');
const STATE_DIR = path.join(ROOT, 'data', 'fetch-state');
fs.mkdirSync(STATE_DIR, { recursive: true });

// Per-domain rate limiting state
const domainState = {
	'api.brokercheck.finra.org': { last: 0, minInterval: 500, defaultMinInterval: 500, pauseUntil: 0 },
	'api.adviserinfo.sec.gov': { last: 0, minInterval: 500, defaultMinInterval: 500, pauseUntil: 0 },
};

function domainFromUrl(u) {
	try {
		return new URL(u).hostname;
	} catch {
		return null;
	}
}

async function waitForDomain(u) {
	const d = domainFromUrl(u);
	if (!d || !domainState[d]) return;
	const state = domainState[d];
	const now = Date.now();
	// If domain is currently paused due to 429, wait until pauseUntil
	if (state.pauseUntil && now < state.pauseUntil) {
		const toWait = state.pauseUntil - now;
		console.warn(`Domain ${d} paused due to previous 429 — waiting ${Math.ceil(toWait / 1000)}s`);
		await sleep(toWait);
	}
	const wait = Math.max(0, state.minInterval - (now - state.last));
	if (wait > 0) await sleep(wait);
}

async function recordDomain(u) {
	const d = domainFromUrl(u);
	if (!d || !domainState[d]) return;
	domainState[d].last = Date.now();
	// on successful request, restore a reasonable minInterval if it was increased
	if (domainState[d].minInterval > domainState[d].defaultMinInterval) {
		domainState[d].minInterval = domainState[d].defaultMinInterval;
	}
}

// simple persistent progress tracking so run can resume
function stateFileForFirm(firmId) {
	return path.join(STATE_DIR, `${firmId}.json`);
}

function loadFirmState(firmId) {
	const p = stateFileForFirm(firmId);
	try {
		return JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
	} catch {
		return { done: false, processed: [] };
	}
}

function saveFirmState(firmId, state) {
	const p = stateFileForFirm(firmId);
	try {
		fs.writeFileSync(p, JSON.stringify(state));
	} catch (e) {
		console.warn('failed to save state', p, e.message);
	}
}

function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

async function fetchJson(url) {
	const MAX_RETRIES = 5;
	let attempt = 0;
	const baseBackoff = 500;
	while (attempt < MAX_RETRIES) {
		attempt += 1;
		try {
			await waitForDomain(url);
			const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'finra-data-batch/1.0' } });
			await recordDomain(url);
			return res.data;
		} catch (err) {
			const status = err?.response?.status;
			if (status === 429) {
				// On 429, set a long pause for this domain and back off for 5 minutes before resuming.
				const d = domainFromUrl(url);
				const backoffMs = 5 * 60 * 1000; // 5 minutes
				if (d && domainState[d]) {
					domainState[d].pauseUntil = Date.now() + backoffMs;
					// increase minInterval to slow subsequent requests
					domainState[d].minInterval = Math.max(domainState[d].minInterval, 2000);
				}
				console.warn(`fetch returned 429 for ${url} — pausing requests to domain for ${Math.ceil(backoffMs / 1000)}s`);
				await sleep(backoffMs + 2000);
				continue;
			}
			if ((status && status >= 500) || !status) {
				const delay = baseBackoff * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);
				console.warn(`fetch failed ${url} (attempt ${attempt}) status=${status} — retrying in ${delay}ms`);
				await sleep(delay);
				continue;
			}
			console.warn('fetch failed', url, err?.message || err);
			return null;
		}
	}
	console.warn('fetch failed after retries', url);
	return null;
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

function discoverFirms() {
	const set = new Set();
	// from data/firm-connections filenames
	try {
		const entries = fs.readdirSync(FIRM_CONN_DIR).filter((f) => f.endsWith('.json'));
		for (const e of entries) {
			const id = e.replace(/\.json$/i, '');
			if (/^\d+$/.test(id)) set.add(id);
		}
	} catch (e) {}

	// from national brokercheck/adviserinfo firm files
	try {
		const bents = fs.existsSync(BROKER_DIR) ? fs.readdirSync(BROKER_DIR) : [];
		for (const name of bents) {
			let m = name.match(/^api\.brokercheck\.finra\.org_search_firm_(\d+)\.json$/i);
			if (m) set.add(m[1]);
			m = name.match(/^firm_(\d+)\.json$/i);
			if (m) set.add(m[1]);
		}
	} catch (e) {}

	try {
		const sents = fs.existsSync(SEC_DIR) ? fs.readdirSync(SEC_DIR) : [];
		for (const name of sents) {
			let m = name.match(/^api\.adviserinfo\.sec\.gov_search_firm_(\d+)\.json$/i);
			if (m) set.add(m[1]);
			m = name.match(/^firm_(\d+)\.json$/i);
			if (m) set.add(m[1]);
		}
	} catch (e) {}

	// top-level national finra-firm / sec-firm
	try {
		const top = fs.readdirSync(DATA_ROOT).filter((f) => f.endsWith('.json'));
		for (const name of top) {
			let m = name.match(/^finra-firm-(\d+)\.json$/i);
			if (m) set.add(m[1]);
			m = name.match(/^sec-firm-(\d+)\.json$/i);
			if (m) set.add(m[1]);
		}
	} catch (e) {}

	// optional firms file
	if (FIRMS_FILE) {
		try {
			const txt = fs.readFileSync(path.resolve(FIRMS_FILE), 'utf-8');
			const toks = txt.split(/[^0-9]+/).filter(Boolean);
			for (const t of toks) if (/^\d+$/.test(t)) set.add(t);
		} catch (e) {}
	}

	return Array.from(set).sort((a, b) => Number(a) - Number(b));
}

function brokerFilenameForFirm(crd) {
	return `api.brokercheck.finra.org_search_firm_${crd}.json`;
}
function secFilenameForFirm(crd) {
	return `api.adviserinfo.sec.gov_search_firm_${crd}.json`;
}
function brokerFilenameForIndividual(crd) {
	return `api.brokercheck.finra.org_search_individual_${crd}.json`;
}
function secFilenameForIndividual(crd) {
	return `api.adviserinfo.sec.gov_search_individual_${crd}.json`;
}

async function fetchFirmListsAndIndividuals(firmId, perFirmConcurrency = PER_FIRM_CONCURRENCY) {
	const maxApiRows = 100;
	const finraUrl = `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&includePrevious&hl=true&wt=json&nrows=${maxApiRows}`;
	const secUrl = `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&includePrevious&hl=true&wt=json&nrows=${maxApiRows}`;

	const [finraList, secList] = await Promise.all([fetchJson(finraUrl), fetchJson(secUrl)]);
	// save firm-level responses
	try {
		if (finraList) fs.writeFileSync(path.join(BROKER_DIR, brokerFilenameForFirm(firmId)), JSON.stringify(finraList));
	} catch (e) {}
	try {
		if (secList) fs.writeFileSync(path.join(SEC_DIR, secFilenameForFirm(firmId)), JSON.stringify(secList));
	} catch (e) {}

	const finraCrds = extractCrdsFromSearchPayload(finraList);
	const secCrds = extractCrdsFromSearchPayload(secList);
	const crds = Array.from(new Set([...finraCrds, ...secCrds]));

	// load per-firm state to resume
	const firmState = loadFirmState(firmId);
	const processedSet = new Set(Array.isArray(firmState.processed) ? firmState.processed : []);

	if (crds.length === 0) return { firmId, count: 0 };

	// worker pool for individuals
	let idx = 0;
	async function worker() {
		while (true) {
			const i = idx++;
			if (i >= crds.length) break;
			const crd = crds[i];
			if (processedSet.has(crd)) continue;
			console.log(`  [firm ${firmId}] (${i + 1}/${crds.length}) fetching individual ${crd}`);
			// fetch individual details
			const finraDetailUrl = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&wt=json&includePrevious=true&nrows=12`;
			const secDetailUrl = `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?hl=true&wt=json&includePrevious=true&nrows=12`;
			const [finraInd, secInd] = await Promise.all([fetchJson(finraDetailUrl), fetchJson(secDetailUrl)]);

			if (finraInd) {
				try {
					fs.writeFileSync(path.join(BROKER_DIR, brokerFilenameForIndividual(crd)), JSON.stringify(finraInd));
				} catch (e) {}
				try {
					fs.writeFileSync(path.join(DATA_ROOT, `finra-individual-${crd}.json`), JSON.stringify(finraInd));
				} catch (e) {}
				try {
					await redis.select(1);
					await redis.set(`finra:individual:${crd}`, JSON.stringify(finraInd));
				} catch (e) {
					console.warn('redis finra write error', e.message);
				}
			}
			if (secInd) {
				try {
					fs.writeFileSync(path.join(SEC_DIR, secFilenameForIndividual(crd)), JSON.stringify(secInd));
				} catch (e) {}
				try {
					fs.writeFileSync(path.join(DATA_ROOT, `sec-individual-${crd}.json`), JSON.stringify(secInd));
				} catch (e) {}
				try {
					await redis.select(1);
					await redis.set(`sec:individual:${crd}`, JSON.stringify(secInd));
				} catch (e) {
					console.warn('redis sec write error', e.message);
				}
			}
			// mark processed and persist state so we can resume
			processedSet.add(crd);
			saveFirmState(firmId, { done: false, processed: Array.from(processedSet) });

			await sleep(150); // polite per-individual pause
		}
	}

	const workers = [];
	for (let i = 0; i < Math.max(1, perFirmConcurrency); i++) workers.push(worker());
	await Promise.all(workers);
	// mark firm done
	saveFirmState(firmId, { done: true, processed: Array.from(processedSet) });
	return { firmId, count: crds.length };
}

async function main() {
	const firms = discoverFirms().slice(0, LIMIT);
	console.log(`Discovered ${firms.length} firm CRDs to check (limit=${LIMIT})`);
	if (firms.length === 0) {
		console.log('No firms discovered. Exiting.');
		return;
	}

	let idx = 0;
	async function worker() {
		while (true) {
			const i = idx++;
			if (i >= firms.length) break;
			const firmId = firms[i];
			console.log(`Processing firm ${i + 1}/${firms.length}: ${firmId}`);
			try {
				const res = await fetchFirmListsAndIndividuals(firmId);
				console.log(`Finished firm ${firmId}: found ${res.count} person CRDs`);
			} catch (e) {
				console.warn(`Error processing firm ${firmId}:`, e?.message || e);
			}
			await sleep(300); // polite pause between firms
		}
	}

	const workers = [];
	for (let i = 0; i < Math.max(1, CONCURRENCY); i++) workers.push(worker());
	await Promise.all(workers);
	console.log('All firms processed');
	redis.disconnect();
}

main().catch((err) => {
	console.error(err);
	redis.disconnect();
	process.exit(1);
});
