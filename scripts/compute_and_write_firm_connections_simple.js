#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Redis = require('ioredis');
const argv = require('minimist')(process.argv.slice(2));

const firmId = String(argv.firm || argv.f || '').trim();
if (!firmId) {
	console.error('Usage: --firm <CRD>');
	process.exit(2);
}

const ROOT = process.cwd();
const DATA_ROOT = path.join(ROOT, 'data', 'national');
const BROKER_DIR = path.join(DATA_ROOT, 'brokercheck.finra.org');
const SEC_DIR = path.join(DATA_ROOT, 'adviserinfo.sec.gov');
const OUT_DIR = path.join(ROOT, 'data', 'firm-connections');
fs.mkdirSync(OUT_DIR, { recursive: true });

const redis = new Redis('redis://127.0.0.1:6379');

async function fetchJson(url) {
	try {
		const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'finra-data-batch/1.0' } });
		return res.data;
	} catch (e) {
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

async function getFirmListCrds() {
	const maxApiRows = 100;
	const finraUrl = `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&includePrevious&hl=true&wt=json&nrows=${maxApiRows}`;
	const secUrl = `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&includePrevious&hl=true&wt=json&nrows=${maxApiRows}`;
	const [finra, sec] = await Promise.all([fetchJson(finraUrl), fetchJson(secUrl)]);
	return Array.from(new Set([...extractCrdsFromSearchPayload(finra), ...extractCrdsFromSearchPayload(sec)]));
}

function firstNonEmpty(...vals) {
	for (const v of vals) {
		const t = String(v ?? '').trim();
		if (t) return t;
	}
	return '';
}

function gatherConnectionsFromPayload(src, sourceName) {
	const entries = [];
	if (!src) return entries;

	// helper to safely get nested properties
	const nestedGet = (obj, path) => {
		if (!obj || !path) return undefined;
		const parts = path.split('.');
		let cur = obj;
		for (const p of parts) {
			if (cur == null) return undefined;
			cur = cur[p];
		}
		return cur;
	};

	const crd = String(
		firstNonEmpty(
			src.ind_source_id,
			src.ind_crd,
			src.individualId,
			src.id,
			src.crd,
			nestedGet(src, 'basicInformation.individualId'),
			nestedGet(src, 'basicInformation.individualId'),
		) ?? '',
	).trim();
	if (!crd) return entries;

	const name = firstNonEmpty(
		[src.ind_firstname, src.ind_middlename, src.ind_lastname].filter(Boolean).join(' '),
		src.individualName,
		src.name,
		src.label,
		(() => {
			const first = nestedGet(src, 'basicInformation.firstName');
			const last = nestedGet(src, 'basicInformation.lastName');
			if (first || last) return [first, last].filter(Boolean).join(' ');
			return '';
		})(),
	);

	// collect employment arrays from several possible field names used across payloads
	const collectArrays = (obj, variants) => {
		const out = [];
		for (const v of variants) {
			if (Array.isArray(obj?.[v])) out.push(...obj[v]);
			if (Array.isArray(obj?.[v.toLowerCase()])) out.push(...obj[v.toLowerCase()]);
			const alt = v.replace(/IA/i, 'Ia');
			if (Array.isArray(obj?.[alt])) out.push(...obj[alt]);
		}
		return out;
	};

	const currentEmployments = collectArrays(src, [
		'ind_current_employments',
		'currentEmployments',
		'ind_currentIAEmployments',
		'currentIAEmployments',
		'ind_current_ia_employments',
	]);
	const previousEmployments = collectArrays(src, [
		'ind_previous_employments',
		'previousEmployments',
		'ind_previousIAEmployments',
		'previousIAEmployments',
		'ind_previous_ia_employments',
	]);

	for (const e of currentEmployments) {
		const firm = firstNonEmpty(e?.firmId, e?.firm_id, e?.firmIdNumber);
		if (firm === firmId) {
			entries.push({
				individualId: crd,
				name,
				relationship: 'Current registration',
				startDate: firstNonEmpty(e?.registrationBeginDate, e?.startDate) || undefined,
				endDate: undefined,
				isCurrent: true,
			});
		}
	}
	for (const e of previousEmployments) {
		const firm = firstNonEmpty(e?.firmId, e?.firm_id, e?.firmIdNumber);
		if (firm === firmId) {
			entries.push({
				individualId: crd,
				name,
				relationship: 'Previous registration',
				startDate: firstNonEmpty(e?.registrationBeginDate, e?.startDate) || undefined,
				endDate: firstNonEmpty(e?.registrationEndDate, e?.endDate) || undefined,
				isCurrent: false,
			});
		}
	}
	return entries;
}

async function loadIndividualFromDiskOrRedis(crd) {
	// try broker JSON
	const brokerPath = path.join(BROKER_DIR, `api.brokercheck.finra.org_search_individual_${crd}.json`);
	const secPath = path.join(SEC_DIR, `api.adviserinfo.sec.gov_search_individual_${crd}.json`);
	try {
		if (fs.existsSync(brokerPath)) return JSON.parse(fs.readFileSync(brokerPath, 'utf-8'));
		if (fs.existsSync(secPath)) return JSON.parse(fs.readFileSync(secPath, 'utf-8'));
		const topFin = path.join(DATA_ROOT, `finra-individual-${crd}.json`);
		if (fs.existsSync(topFin)) return JSON.parse(fs.readFileSync(topFin, 'utf-8'));
	} catch (e) {}
	// fallback to redis DB1
	try {
		await redis.select(1);
		const fin = await redis.get(`finra:individual:${crd}`);
		if (fin) return JSON.parse(fin);
		const s = await redis.get(`sec:individual:${crd}`);
		if (s) return JSON.parse(s);
	} catch (e) {}
	return null;
}

async function compute() {
	console.log('Computing simple firm connections for', firmId);
	const crds = await getFirmListCrds();
	console.log('Firm-level lists include', crds.length, 'CRDs');
	// If external firm lists were unavailable (rate-limited), fall back to scanning
	// local individual payloads to discover any employments that reference this firm.
	if (crds.length === 0) {
		console.log('No firm-level CRDs found (possibly rate-limited). Falling back to local scan of individual files.');
		const localCrds = new Set();
		try {
			const top = fs.readdirSync(DATA_ROOT).filter((f) => f.endsWith('.json'));
			for (const name of top) {
				let m = name.match(/^finra-individual-(\d+)\.json$/i) || name.match(/^sec-individual-(\d+)\.json$/i);
				if (m) localCrds.add(m[1]);
			}
		} catch (e) {}
		try {
			const bents = fs.existsSync(BROKER_DIR) ? fs.readdirSync(BROKER_DIR) : [];
			for (const name of bents) {
				let m = name.match(/^api\.brokercheck\.finra\.org_search_individual_(\d+)\.json$/i);
				if (m) localCrds.add(m[1]);
			}
		} catch (e) {}
		try {
			const sents = fs.existsSync(SEC_DIR) ? fs.readdirSync(SEC_DIR) : [];
			for (const name of sents) {
				let m = name.match(/^api\.adviserinfo\.sec\.gov_search_individual_(\d+)\.json$/i);
				if (m) localCrds.add(m[1]);
			}
		} catch (e) {}
		console.log('Discovered', localCrds.size, 'local individual files to scan');
		crds.push(...Array.from(localCrds));
	}
	const current = [];
	const previous = [];
	const seen = new Set();
	for (const crd of crds) {
		const payload = await loadIndividualFromDiskOrRedis(crd);
		if (!payload) continue;
		// payload may have hits.hits or be source object
		let src = payload;
		if (payload.hits && Array.isArray(payload.hits.hits) && payload.hits.hits.length) {
			src = payload.hits.hits[0]._source || payload.hits.hits[0];
		}

		// Some payloads wrap the useful data as a JSON string in `content`.
		if (src && typeof src.content === 'string') {
			try {
				const parsed = JSON.parse(src.content);
				// prefer parsed inner content but keep top-level fields if helpful
				src = { ...src, ...parsed };
			} catch (e) {
				// ignore parse errors
			}
		}
		const entries = gatherConnectionsFromPayload(src);
		for (const e of entries) {
			const key = `${e.individualId}:${e.isCurrent}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (e.isCurrent) current.push(e);
			else previous.push(e);
		}
	}
	const out = { currentConnections: current, previousConnections: previous };

	const outPath = path.join(OUT_DIR, `${firmId}.json`);
	fs.writeFileSync(outPath, JSON.stringify(out));
	console.log('Wrote', outPath, 'current=', current.length, 'previous=', previous.length);

	try {
		await redis.select(1);
		await redis.set(`graph:firm-connections:v9:${firmId}`, JSON.stringify(out));
		console.log('Wrote Redis graph:firm-connections:v9:', firmId);
	} catch (e) {
		console.warn('Redis write failed', e.message);
	}

	redis.disconnect();
}

compute().catch((err) => {
	console.error(err);
	redis.disconnect();
	process.exit(1);
});
