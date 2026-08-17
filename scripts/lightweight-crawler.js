#!/usr/bin/env node
// Lightweight crawler: detects new CRDs from data/raw, creates placeholder
// `data/firm-connections/<crd>.json` entries for orphan CRDs, updates
// `data/crd-log.json`, and optionally publishes the CRD count to Redis when
// AUTO_PUBLISH_DASHBOARD=1 is set in the environment.

const fs = require('fs');
const path = require('path');
const child = require('child_process');

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'data', 'raw');
const FIRM_CONN = path.join(ROOT, 'data', 'firm-connections');
const CRD_LOG = path.join(ROOT, 'data', 'crd-log.json');

function walk(dir, cb) {
	if (!fs.existsSync(dir)) return;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, cb);
		else cb(full);
	}
}

function scanRaw() {
	const indiv = new Set();
	const firm = new Set();
	if (!fs.existsSync(RAW)) return { indiv, firm };
	walk(RAW, (file) => {
		const m1 = file.match(/search_individual_([0-9]+)\.json$/);
		if (m1) return indiv.add(m1[1]);
		const m2 = file.match(/search_firm_([0-9]+)\.json$/);
		if (m2) return firm.add(m2[1]);
		const m3 = file.match(/search_(?:individual|firm)_([0-9]+)\.json$/);
		if (m3) {
			// best-effort fallback: treat as individual
			indiv.add(m3[1]);
		}
	});
	return { indiv, firm };
}

function loadCrdLog() {
	if (!fs.existsSync(CRD_LOG)) return { updatedAt: new Date().toISOString(), summary: { firms: 0, individuals: 0, total: 0 }, firms: [], individuals: [] };
	try {
		return JSON.parse(fs.readFileSync(CRD_LOG, 'utf-8'));
	} catch (e) {
		console.error('Failed to parse crd-log.json, backing up and recreating');
		fs.copyFileSync(CRD_LOG, CRD_LOG + '.bak');
		return { updatedAt: new Date().toISOString(), summary: { firms: 0, individuals: 0, total: 0 }, firms: [], individuals: [] };
	}
}

function writeCrdLog(obj) {
	obj.updatedAt = new Date().toISOString();
	fs.writeFileSync(CRD_LOG, JSON.stringify(obj, null, 2));
}

function ensureFirmConnDir() {
	if (!fs.existsSync(FIRM_CONN)) fs.mkdirSync(FIRM_CONN, { recursive: true });
}

function createPlaceholder(crd, type) {
	ensureFirmConnDir();
	const file = path.join(FIRM_CONN, `${crd}.json`);
	if (fs.existsSync(file)) return false;
	const payload = {
		id: Number(crd),
		type: type === 'firm' ? 'firm' : 'individual',
		createdAt: new Date().toISOString(),
		source: 'lightweight-crawler',
		placeholder: true,
	};
	fs.writeFileSync(file, JSON.stringify(payload, null, 2));
	return true;
}

async function isLiveInRedis(crd, type) {
	// Check Upstash or local Redis for an existing live payload for this CRD.
	// We consider a CRD "live" if either finra:firm:<crd> or finra:individual:<crd>
	// exists in Redis.
	const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
	const useLocal = process.env.USE_LOCAL_REDIS === '1';
	if (!hasUpstash && !useLocal) return false;

	try {
		if (hasUpstash) {
			const { Redis } = require('@upstash/redis');
			const client = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
			const k1 = `finra:firm:${crd}`;
			const k2 = `finra:individual:${crd}`;
			const v1 = await client.get(k1);
			if (v1 != null) return true;
			const v2 = await client.get(k2);
			if (v2 != null) return true;
			return false;
		}

		if (useLocal) {
			const IORedis = require('ioredis');
			const client = new IORedis(process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379');
			const k1 = `finra:firm:${crd}`;
			const k2 = `finra:individual:${crd}`;
			const v1 = await client.get(k1);
			if (v1 != null) {
				client.disconnect();
				return true;
			}
			const v2 = await client.get(k2);
			client.disconnect();
			if (v2 != null) return true;
			return false;
		}
	} catch (e) {
		console.warn('isLiveInRedis check failed:', e?.message || e);
		return false;
	}
}

async function main() {
	const { indiv, firm } = scanRaw();
	const crdLog = loadCrdLog();

	const existingFirms = new Set((crdLog.firms || []).map((f) => String(f.id)));
	const existingInd = new Set((crdLog.individuals || []).map((i) => String(i.id)));

	let created = 0;

	for (const id of firm) {
		if (!existingFirms.has(String(id))) {
			// add to crd-log firms
			(crdLog.firms = crdLog.firms || []).push({ id: Number(id), name: '' });
			existingFirms.add(String(id));
		}
		// ensure placeholder file exists in data/firm-connections
		if (createPlaceholder(id, 'firm')) created++;
	}

	for (const id of indiv) {
		if (!existingInd.has(String(id))) {
			(crdLog.individuals = crdLog.individuals || []).push({ id: Number(id), name: '' });
			existingInd.add(String(id));
		}
		if (createPlaceholder(id, 'individual')) created++;
	}

	// normalize summary
	const firmsCount = (crdLog.firms || []).length;
	const indivCount = (crdLog.individuals || []).length;
	crdLog.summary = {
		firms: firmsCount,
		individuals: indivCount,
		total: new Set([...(crdLog.firms || []).map((f) => String(f.id)), ...(crdLog.individuals || []).map((i) => String(i.id))]).size,
	};

	writeCrdLog(crdLog);

	console.log('crawler: discovered', indiv.size, 'individuals and', firm.size, 'firms in data/raw');
	console.log('crawler: created placeholder files:', created);
	console.log('crawler: crd-log summary ->', crdLog.summary);

	// Optionally publish count to Redis if AUTO_PUBLISH_DASHBOARD=1
	if (process.env.AUTO_PUBLISH_DASHBOARD === '1') {
		console.log('AUTO_PUBLISH_DASHBOARD enabled -> publishing to Redis via scripts/set-dashboard-crd-count.js');
		try {
			// call the existing script which will publish using env creds
			child.execSync('node scripts/set-dashboard-crd-count.js', { stdio: 'inherit' });
		} catch (e) {
			console.error('Failed to auto-publish dashboard count:', e?.message || e);
		}
	} else {
		console.log('AUTO_PUBLISH_DASHBOARD not set; skipping Redis publish. To enable, set AUTO_PUBLISH_DASHBOARD=1 in environment when running the crawler.');
	}
}

main().catch((e) => {
	console.error('ERROR', e?.message || e);
	process.exit(1);
});
