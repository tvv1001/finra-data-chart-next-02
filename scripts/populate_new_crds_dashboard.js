#!/usr/bin/env node
/*
Populate data/derived/new-crds-dashboard.json from Redis 'dashboard:new-crds-cache'.

Behavior:
- Read `dashboard:new-crds-cache` from Upstash (or local Redis via UPSTASH envs).
- Normalize entries into the other app's expected `new-crds-dashboard.json` shape.
- Ensure at least 20 individual and 20 firm entries by supplementing from
  `dashboard:highest-crds:individual` and `dashboard:highest-crds:firm` zsets.
- Write to data/derived/new-crds-dashboard.json (created if missing).

Usage:
  # load env from .env.local automatically if present
  node scripts/populate_new_crds_dashboard.js

Options via env:
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (preferred)
  OR provide UPSTASH_REDIS_REST_URL_SRC and UPSTASH_REDIS_REST_TOKEN_SRC to target a specific DB

Run this from the repo root. Safe to run as a cron once per day.
*/

const fs = require('fs').promises;
const path = require('path');
const { existsSync } = require('fs');
try {
	// dotenv is optional in this repo; load if available
	require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
} catch (e) {}

async function safeMkdir(dir) {
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch (e) {}
}

function inferTypeFromId(id) {
	const txt = String(id || '').toLowerCase();
	if (txt.includes('firm') || txt.includes('f')) return 'firm';
	return 'individual';
}

function normalizeNewCrdEntry(e) {
	// e expected shape: { id, type, name, found, date, scopes }
	let crd = '';
	if (e.id && String(e.id).includes(':')) {
		crd = String(e.id).split(':').pop();
	} else if (e.id) {
		crd = String(e.id).replace(/[^0-9]/g, '');
	}
	const type = (e.type && String(e.type).toLowerCase()) || inferTypeFromId(e.type || e.id || 'individual');
	const sources = Array.isArray(e.scopes) ? e.scopes.map(String) : [];
	return {
		id: `${type}:${crd}`,
		type,
		crd: String(crd),
		foundAt: e.date || new Date().toISOString(),
		sources: sources.length ? sources : ['finra'],
		savedFiles: [],
	};
}

async function main() {
	const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL_SRC || process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL_MIRROR;
	const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN_SRC || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR;

	if (!UPSTASH_URL || !UPSTASH_TOKEN) {
		console.error('Missing Upstash envs. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or _SRC variants).');
		process.exit(2);
	}

	let Redis;
	try {
		Redis = require('@upstash/redis').Redis;
	} catch (e) {
		console.error('Please install @upstash/redis dependency in this project to run this script.');
		process.exit(3);
	}

	const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

	// target file
	const outPath = path.join(process.cwd(), 'data', 'derived', 'new-crds-dashboard.json');
	await safeMkdir(path.dirname(outPath));

	// try read cache key
	let cached = null;
	try {
		const raw = await redis.get('dashboard:new-crds-cache');
		if (raw) {
			if (typeof raw === 'string') {
				try {
					cached = JSON.parse(raw);
				} catch {
					cached = raw;
				}
			} else cached = raw;
		}
	} catch (e) {
		console.warn('Redis get failed for dashboard:new-crds-cache:', e?.message || e);
	}

	let items = [];
	if (cached && Array.isArray(cached.newCrds)) {
		items = cached.newCrds.map((e) => normalizeNewCrdEntry(e));
	} else if (Array.isArray(cached)) {
		items = cached.map((e) => normalizeNewCrdEntry(e));
	}

	// ensure at least 20 people and 20 firms
	const needIndividuals = Math.max(0, 20 - items.filter((i) => i.type === 'individual').length);
	const needFirms = Math.max(0, 20 - items.filter((i) => i.type === 'firm').length);

	async function supplementFromZset(zkey, type, need) {
		if (!need) return [];
		try {
			// fetch top IDs (rev true) — zrange start 0 stop 99
			const ids = await redis.zrange(zkey, 0, 99, { rev: true });
			const picked = [];
			for (const id of ids) {
				const crd = String(id || '').replace(/[^0-9]/g, '');
				if (!crd) continue;
				if (items.some((it) => it.crd === crd && it.type === type)) continue;
				picked.push({ id: `${type}:${crd}`, type, crd: String(crd), foundAt: new Date().toISOString(), sources: ['finra'], savedFiles: [] });
				if (picked.length >= need) break;
			}
			return picked;
		} catch (e) {
			console.warn('Failed to zrange', zkey, e?.message || e);
			return [];
		}
	}

	if (needIndividuals > 0) {
		const add = await supplementFromZset('dashboard:highest-crds:individual', 'individual', needIndividuals);
		items = items.concat(add);
	}
	if (needFirms > 0) {
		const add = await supplementFromZset('dashboard:highest-crds:firm', 'firm', needFirms);
		items = items.concat(add);
	}

	// If still insufficient, try to load from crd-log.json top entries
	if (items.filter((i) => i.type === 'individual').length < 20 || items.filter((i) => i.type === 'firm').length < 20) {
		try {
			const crdLogPath = path.join(process.cwd(), 'data', 'crd-log.json');
			if (existsSync(crdLogPath)) {
				const rl = JSON.parse(await fs.readFile(crdLogPath, 'utf-8'));
				const ind = Array.isArray(rl.individuals) ? rl.individuals.map((e) => String(e.id)) : [];
				const fr = Array.isArray(rl.firms) ? rl.firms.map((e) => String(e.id)) : [];
				// fill individuals
				for (const crd of ind) {
					if (items.filter((i) => i.type === 'individual').length >= 20) break;
					if (items.some((it) => it.crd === crd && it.type === 'individual')) continue;
					items.push({ id: `individual:${crd}`, type: 'individual', crd: String(crd), foundAt: new Date().toISOString(), sources: ['finra'], savedFiles: [] });
				}
				for (const crd of fr) {
					if (items.filter((i) => i.type === 'firm').length >= 20) break;
					if (items.some((it) => it.crd === crd && it.type === 'firm')) continue;
					items.push({ id: `firm:${crd}`, type: 'firm', crd: String(crd), foundAt: new Date().toISOString(), sources: ['finra'], savedFiles: [] });
				}
			}
		} catch (e) {
			console.warn('Failed to read crd-log.json', e?.message || e);
		}
	}

	// Build final state in the other app format
	const now = new Date().toISOString();
	const maxIndividual = Math.max(0, ...items.filter((i) => i.type === 'individual').map((i) => Number(i.crd) || 0));
	const maxFirm = Math.max(0, ...items.filter((i) => i.type === 'firm').map((i) => Number(i.crd) || 0));

	const state = {
		initializedAt: now,
		lastCheckedAt: now,
		nextCheckAt: null,
		lastRecordedMaxes: { individual: maxIndividual, firm: maxFirm },
		items: items.sort((a, b) => (b.type === a.type ? Number(b.crd) - Number(a.crd) : a.type.localeCompare(b.type))).slice(0, 200),
		lastRun: { status: 'idle', startedAt: null, completedAt: now, exitCode: 0, message: 'Populated from dashboard:new-crds-cache and supplements', logTail: [] },
		manualCooldownUntil: null,
	};

	await fs.writeFile(outPath, JSON.stringify(state, null, 2), 'utf-8');
	console.log(
		'Wrote',
		outPath,
		'with',
		state.items.length,
		'items (individuals:',
		state.items.filter((i) => i.type === 'individual').length,
		'firms:',
		state.items.filter((i) => i.type === 'firm').length,
		')',
	);
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
