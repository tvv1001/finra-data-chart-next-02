#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const ROOT = process.cwd();
const DATA_ROOT = path.join(ROOT, 'data', 'national');
const BROKER_DIR = path.join(DATA_ROOT, 'brokercheck.finra.org');
const SEC_DIR = path.join(DATA_ROOT, 'adviserinfo.sec.gov');
const OUT_DIR = path.join(ROOT, 'data', 'firm-connections');
const ORPHAN_DIR = path.join(DATA_ROOT, 'orphan_firms');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(ORPHAN_DIR, { recursive: true });

const redis = new Redis('redis://127.0.0.1:6379');

function listFiles(dir) {
	try {
		return fs.readdirSync(dir).map((n) => path.join(dir, n));
	} catch (e) {
		return [];
	}
}

function loadJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		return null;
	}
}

function collectFirmIdsFromFirmSearchFiles() {
	const firms = new Set();
	const grab = (dir) => {
		for (const f of listFiles(dir)) {
			const base = path.basename(f);
			const m = base.match(/_search_firm_(\d+)\.json$/);
			if (m) firms.add(m[1]);
		}
	};
	grab(BROKER_DIR);
	grab(SEC_DIR);
	return firms;
}

function collectFirmIdsFromIndividuals() {
	const firms = new Set();
	const collectFromPayload = (payload) => {
		if (!payload) return;
		const hits =
			payload.hits && Array.isArray(payload.hits.hits) ? payload.hits.hits
			: payload.hits && Array.isArray(payload.hits) ? payload.hits
			: null;
		const src = hits && hits.length ? hits[0]._source || hits[0] : payload;
		const obj = src._source || src;
		const content = obj.iacontent || obj.content || obj._source || obj;
		let parsed = obj;
		if (typeof content === 'string') {
			try {
				parsed = JSON.parse(content);
			} catch (e) {
				/* ignore */
			}
		} else if (typeof content === 'object') parsed = content;
		const variants = ['currentEmployments', 'currentIAEmployments', 'previousEmployments', 'previousIAEmployments', 'ind_current_employments', 'ind_previous_employments'];
		for (const v of variants) {
			const arr = parsed[v] || (parsed.basicInformation && parsed[v]) || [];
			if (Array.isArray(arr)) {
				for (const e of arr) {
					const fid = String(e?.firmId || e?.firm_id || e?.firmIdNumber || e?.iaSECNumber || '').trim();
					if (fid && /^\d+$/.test(fid)) firms.add(fid);
				}
			}
		}
	};

	// scan broker dir
	for (const f of listFiles(BROKER_DIR)) {
		const payload = loadJson(f);
		collectFromPayload(payload);
	}
	for (const f of listFiles(SEC_DIR)) {
		const payload = loadJson(f);
		collectFromPayload(payload);
	}
	// also top-level individual files (finra-individual-*.json)
	for (const f of listFiles(DATA_ROOT)) {
		const base = path.basename(f);
		if (/^(finra-individual-|sec-individual-)/i.test(base) && base.endsWith('.json')) {
			const payload = loadJson(path.join(DATA_ROOT, base));
			collectFromPayload(payload);
		}
	}
	return firms;
}

function gatherConnectionsFromPayload(src, firmId) {
	const entries = [];
	if (!src) return entries;
	const firstNonEmpty = (...vals) => {
		for (const v of vals) {
			const t = String(v || '').trim();
			if (t) return t;
		}
		return '';
	};
	const nestedGet = (obj, pathStr) => {
		if (!obj) return undefined;
		const parts = pathStr.split('.');
		let cur = obj;
		for (const p of parts) {
			if (cur == null) return undefined;
			cur = cur[p];
		}
		return cur;
	};
	const crd = String(firstNonEmpty(src.ind_source_id, src.ind_crd, src.individualId, src.id, src.crd, nestedGet(src, 'basicInformation.individualId'))).trim();
	if (!crd) return entries;
	const name = firstNonEmpty(src.individualName, src.name, src.label, `${nestedGet(src, 'basicInformation.firstName') || ''} ${nestedGet(src, 'basicInformation.lastName') || ''}`);
	const collectArrays = (obj, variants) => {
		const out = [];
		for (const v of variants) {
			if (Array.isArray(obj?.[v])) out.push(...obj[v]);
			if (Array.isArray(obj?.[v.toLowerCase()])) out.push(...obj[v.toLowerCase()]);
		}
		return out;
	};
	const currentEmployments = collectArrays(src, ['ind_current_employments', 'currentEmployments', 'ind_currentIAEmployments', 'currentIAEmployments']);
	const previousEmployments = collectArrays(src, ['ind_previous_employments', 'previousEmployments', 'ind_previousIAEmployments', 'previousIAEmployments']);
	for (const e of currentEmployments) {
		const firm = firstNonEmpty(e?.firmId, e?.firm_id, e?.firmIdNumber);
		if (String(firm) === String(firmId)) {
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
		if (String(firm) === String(firmId)) {
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

async function computeForFirm(firmId, localIndividualFiles) {
	const current = [];
	const previous = [];
	const seen = new Set();
	// iterate through local individual files and collect entries
	for (const filePath of localIndividualFiles) {
		const payload = loadJson(filePath);
		if (!payload) continue;
		let src = payload;
		if (payload.hits && Array.isArray(payload.hits.hits) && payload.hits.hits.length) src = payload.hits.hits[0]._source || payload.hits.hits[0];
		if (src && typeof src.content === 'string') {
			try {
				src = { ...src, ...JSON.parse(src.content) };
			} catch (e) {}
		}
		const entries = gatherConnectionsFromPayload(src, firmId);
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
	fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
	console.log('Wrote', outPath, 'current=', current.length, 'previous=', previous.length);
	try {
		await redis.select(1);
		await redis.set(`graph:firm-connections:v9:${firmId}`, JSON.stringify(out));
		console.log('Wrote Redis graph:firm-connections:v9:', firmId);
	} catch (e) {
		console.warn('Redis write failed for', firmId, e.message || e);
	}
}

function findLocalIndividualFiles() {
	const files = [];
	for (const f of listFiles(BROKER_DIR)) files.push(f);
	for (const f of listFiles(SEC_DIR)) files.push(f);
	for (const f of listFiles(DATA_ROOT)) {
		const base = path.basename(f);
		if (/^(finra-individual-|sec-individual-)/i.test(base) && base.endsWith('.json')) files.push(path.join(DATA_ROOT, base));
	}
	return files;
}

function createOrphanTemplateIfMissing(firmId) {
	// If no firm search file exists for this firm, create a minimal orphan template
	const finraFile = path.join(BROKER_DIR, `api.brokercheck.finra.org_search_firm_${firmId}.json`);
	const secFile = path.join(SEC_DIR, `api.adviserinfo.sec.gov_search_firm_${firmId}.json`);
	if (fs.existsSync(finraFile) || fs.existsSync(secFile)) return false;
	const orphanPath = path.join(ORPHAN_DIR, `api.orphan_firm_${firmId}.json`);
	if (fs.existsSync(orphanPath)) return true;
	const tmpl = { orphan: { crd: String(firmId), firmName: null, parentCrd: '', parentType: 'firm', officeAddress: null } };
	fs.writeFileSync(orphanPath, JSON.stringify(tmpl, null, 2));
	console.log('Created orphan template', orphanPath);
	return true;
}

function updateOrphanCrdsJson(orphanFirmIds) {
	const p = path.join(ROOT, 'orphan_crds.json');
	let data = { orphanIndividuals: [] };
	try {
		data = JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch (e) {}
	data.orphanFirms = Array.from(new Set([...(data.orphanFirms || []), ...Array.from(orphanFirmIds)]));
	fs.writeFileSync(p, JSON.stringify(data, null, 2));
	console.log('Updated orphan_crds.json with', orphanFirmIds.size, 'firm ids');
}

async function main() {
	console.log('Reconciling all firms: scanning local files for firm references...');
	const firmSet = collectFirmIdsFromFirmSearchFiles();
	const firmFromIndividuals = collectFirmIdsFromIndividuals();
	for (const f of firmFromIndividuals) firmSet.add(f);
	console.log('Total firm ids discovered:', firmSet.size);
	const individualFiles = findLocalIndividualFiles();
	const orphaned = new Set();
	for (const firmId of firmSet) {
		await computeForFirm(firmId, individualFiles);
		const created = createOrphanTemplateIfMissing(firmId);
		if (created) orphaned.add(firmId);
	}
	if (orphaned.size) updateOrphanCrdsJson(orphaned);
	redis.disconnect();
	console.log('Done.');
}

main().catch((e) => {
	console.error(e);
	redis.disconnect();
	process.exit(1);
});
