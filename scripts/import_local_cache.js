#!/usr/bin/env node
/*
 * import_local_cache.js
 * Scan the local data/national dump and populate Upstash Redis (if configured)
 * or write primed-cache JSON bundles under data/national/primed-cache so the
 * application can serve data without hitting external FINRA/SEC APIs.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { Redis } = require('@upstash/redis');
const argv = require('minimist')(process.argv.slice(2));

const ROOT = process.cwd();
// Allow an external local dump directory via env or CLI. Default to workspace data/national.
const EXTERNAL_LOCAL = process.env.LOCAL_DATA_DIR || '/home/lenny/Dev/Data/national';
const CRD_BATCH_FILE = String(argv['crd-file'] || argv.crdFile || process.env.CRD_BATCH_FILE || '').trim();
const fsSync = require('node:fs');
let NATIONAL;
try {
	fsSync.accessSync(EXTERNAL_LOCAL);
	NATIONAL = EXTERNAL_LOCAL;
} catch {
	NATIONAL = path.join(ROOT, 'data', 'national');
}
const PRIMED_DIR = path.join(NATIONAL, 'primed-cache');
const TTL_SECONDS = 60 * 60 * 24; // 1 day
const REPORT_INTERVAL = 500;

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';

function finraIndividualKey(id) {
	return `finra:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`;
}
function finraFirmKey(id) {
	return `finra:firm:${id}:${DEFAULT_FIRM_QUERY}`;
}

function normalizeId(value) {
	return String(value || '')
		.trim()
		.replace(/^person[:_]/i, '')
		.replace(/^firm[:_]/i, '');
}

function parseBatchPayload(rawText) {
	const text = String(rawText || '').trim();
	if (!text) return { individuals: new Set(), firms: new Set() };
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			return { individuals: new Set(parsed.map(normalizeId).filter((value) => /^\d+$/.test(value))), firms: new Set() };
		}
		const individuals = Array.isArray(parsed?.individuals) ? parsed.individuals.map(normalizeId).filter((value) => /^\d+$/.test(value)) : [];
		const firms = Array.isArray(parsed?.firms) ? parsed.firms.map(normalizeId).filter((value) => /^\d+$/.test(value)) : [];
		return { individuals: new Set(individuals), firms: new Set(firms) };
	} catch {
		const tokens = text
			.split(/[\s,]+/g)
			.map(normalizeId)
			.filter((value) => /^\d+$/.test(value));
		return { individuals: new Set(tokens), firms: new Set(tokens) };
	}
}

async function loadBatchFilter(filePath) {
	if (!filePath) return null;
	const resolved = path.resolve(filePath);
	const raw = await fs.readFile(resolved, 'utf-8');
	const filter = parseBatchPayload(raw);
	console.log(`Using CRD batch filter from ${resolved}: individuals=${filter.individuals.size}, firms=${filter.firms.size}`);
	return filter;
}

async function fileExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	const useRedis = Boolean(url && token);
	const redis = useRedis ? new Redis({ url, token }) : null;
	const batchFilter = await loadBatchFilter(CRD_BATCH_FILE).catch((err) => {
		console.error(`Failed to load CRD batch file ${CRD_BATCH_FILE}:`, err?.message || err);
		process.exit(1);
	});
	const hasBatchFilter = Boolean(batchFilter);

	const primedBundles = {
		'finra-individual': {},
		'sec-individual': {},
	};

	let written = 0;
	let skipped = 0;
	let processed = 0;
	const counts = {
		root: 0,
		brokercheck: 0,
		adviserinfo: 0,
	};
	function logProgress() {
		console.log(`import progress written=${written} skipped=${skipped} processed=${processed}`);
	}

	// ensure primed dir exists when not using redis
	if (!useRedis) {
		await fs.mkdir(PRIMED_DIR, { recursive: true });
	}

	console.log('Starting import from national data directory:', NATIONAL);
	if (hasBatchFilter) {
		console.log('Batch filtering is enabled; only matching CRDs will be imported.');
	}
	// read top-level national dir for finra-individual-*.json
	const entries = await fs.readdir(NATIONAL);
	for (const name of entries) {
		const p = path.join(NATIONAL, name);
		if (name.startsWith('finra-individual-') && name.endsWith('.json')) {
			const id = name.replace('finra-individual-', '').replace('.json', '');
			if (batchFilter && !batchFilter.individuals.has(normalizeId(id))) continue;
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const parsed = JSON.parse(raw);
				const key = finraIndividualKey(id);
				if (useRedis) {
					const exists = await redis.get(key);
					if (exists != null) {
						skipped++;
						counts.root++;
						processed++;
						if (processed % REPORT_INTERVAL === 0) logProgress();
						continue;
					}
					await redis.set(key, JSON.stringify(parsed), { ex: TTL_SECONDS });
					written++;
					counts.root++;
					processed++;
					if (processed % REPORT_INTERVAL === 0) logProgress();
				} else {
					primedBundles['finra-individual'][key] = parsed;
					written++;
					counts.root++;
					processed++;
					if (processed % REPORT_INTERVAL === 0) logProgress();
				}
			} catch (err) {
				console.warn('failed to import', p, err?.message || err);
			}
		}
	}

	// also import brokercheck.finra.org search response JSON files and legacy firm_<id>.json files
	const brokerDir = path.join(NATIONAL, 'brokercheck.finra.org');
	if (await fileExists(brokerDir)) {
		const bents = await fs.readdir(brokerDir);
		for (const name of bents) {
			let id;
			let type;
			if (name.startsWith('firm_') && name.endsWith('.json')) {
				type = 'firm';
				id = name.replace('firm_', '').replace('.json', '');
			} else {
				const match = name.match(/^api\.brokercheck\.finra\.org_search_(individual|firm)_(\d+)\.json$/);
				if (match) {
					type = match[1];
					id = match[2];
				}
			}
			if (!type || !id) continue;
			if (batchFilter) {
				const normalized = normalizeId(id);
				if (type === 'individual' && !batchFilter.individuals.has(normalized)) continue;
				if (type === 'firm' && !batchFilter.firms.has(normalized)) continue;
			}
			const p = path.join(brokerDir, name);
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const parsed = JSON.parse(raw);
				if (type !== 'individual') continue;
				const key = finraIndividualKey(id);
				if (useRedis) {
					const exists = await redis.get(key);
					if (exists != null) {
						skipped++;
						counts.brokercheck++;
						processed++;
						if (processed % REPORT_INTERVAL === 0) logProgress();
						continue;
					}
					await redis.set(key, JSON.stringify(parsed), { ex: TTL_SECONDS });
					written++;
					counts.brokercheck++;
					processed++;
					if (processed % REPORT_INTERVAL === 0) logProgress();
				} else {
					primedBundles[`finra-${type}`][key] = parsed;
					written++;
					counts.brokercheck++;
					processed++;
					if (processed % REPORT_INTERVAL === 0) logProgress();
				}
			} catch (err) {
				console.warn('failed to import', p, err?.message || err);
			}
		}
	}

	// import adviserinfo.sec.gov search response JSON files and legacy firm_<id>.json files
	const secDir = path.join(NATIONAL, 'adviserinfo.sec.gov');
	if (await fileExists(secDir)) {
		const sents = await fs.readdir(secDir);
		for (const name of sents) {
			let id;
			let type;
			if (name.startsWith('firm_') && name.endsWith('.json')) {
				type = 'firm';
				id = name.replace('firm_', '').replace('.json', '');
			} else {
				const match = name.match(/^api\.adviserinfo\.sec\.gov_search_(individual|firm)_(\d+)\.json$/);
				if (match) {
					type = match[1];
					id = match[2];
				}
			}
			if (!type || !id) continue;
			if (batchFilter) {
				const normalized = normalizeId(id);
				if (type === 'individual' && !batchFilter.individuals.has(normalized)) continue;
				if (type === 'firm' && !batchFilter.firms.has(normalized)) continue;
			}
			const p = path.join(secDir, name);
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const parsed = JSON.parse(raw);
				if (type !== 'individual') continue;
				const key = `sec:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`;
				if (useRedis) {
					const exists = await redis.get(key);
					if (exists != null) {
						skipped++;
						counts.adviserinfo++;
						processed++;
						if (processed % REPORT_INTERVAL === 0) logProgress();
						continue;
					}
					await redis.set(key, JSON.stringify(parsed), { ex: TTL_SECONDS });
					written++;
					counts.adviserinfo++;
					processed++;
					if (processed % REPORT_INTERVAL === 0) logProgress();
				} else {
					primedBundles[`sec-${type}`][key] = parsed;
					written++;
					counts.adviserinfo++;
					processed++;
					if (processed % REPORT_INTERVAL === 0) logProgress();
				}
			} catch (err) {
				console.warn('failed to import', p, err?.message || err);
			}
		}
	}

	// write primed bundle files if not using redis
	if (!useRedis) {
		const PROJECT_PRIMED_DIR = path.join(process.cwd(), 'data', 'national', 'primed-cache');
		await fs.mkdir(PROJECT_PRIMED_DIR, { recursive: true });
		const zlib = require('node:zlib');
		for (const [name, obj] of Object.entries(primedBundles)) {
			const out = path.join(PRIMED_DIR, `${name}.json`);
			try {
				// merge with existing bundle if present (external bundle)
				let existing = {};
				if (await fileExists(out)) {
					try {
						existing = JSON.parse(await fs.readFile(out, 'utf-8')) || {};
					} catch {}
				}
				const merged = { ...existing, ...obj };
				await fs.writeFile(out, JSON.stringify(merged), 'utf-8');
			} catch (err) {
				console.warn('failed to write primed bundle', out, err?.message || err);
			}

			// write gzipped binary into project path for server-only consumption
			try {
				const projectOutJson = path.join(PROJECT_PRIMED_DIR, `${name}.json`);
				let existingProj = {};
				if (await fileExists(projectOutJson)) {
					try {
						existingProj = JSON.parse(await fs.readFile(projectOutJson, 'utf-8')) || {};
					} catch {}
				}
				const mergedProj = { ...existingProj, ...obj };
				const mergedBuf = Buffer.from(JSON.stringify(mergedProj), 'utf-8');
				const gz = zlib.gzipSync(mergedBuf);
				await fs.writeFile(path.join(PROJECT_PRIMED_DIR, `${name}.bin`), gz);
				// also keep a small JSON for debugging (optional)
				await fs.writeFile(projectOutJson, JSON.stringify(mergedProj), 'utf-8');
			} catch (err) {
				console.warn('failed to write project primed binary', err?.message || err);
			}
		}
	}

	console.log(`import complete. written=${written} skipped=${skipped} processed=${processed} usingRedis=${useRedis}`);
	console.log(`import counts: root=${counts.root} brokercheck=${counts.brokercheck} adviserinfo=${counts.adviserinfo}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
