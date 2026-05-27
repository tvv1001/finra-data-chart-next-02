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

const ROOT = process.cwd();
// Allow an external local dump directory via env or CLI. Default to workspace data/national.
const EXTERNAL_LOCAL = process.env.LOCAL_DATA_DIR || '/home/lenny/Dev/Data/national';
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

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';

function finraIndividualKey(id) {
	return `finra:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`;
}
function finraFirmKey(id) {
	return `finra:firm:${id}:${DEFAULT_FIRM_QUERY}`;
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

	const primedBundles = {
		'finra-individual': {},
		'finra-firm': {},
		'sec-individual': {},
		'sec-firm': {},
	};

	let written = 0;
	let skipped = 0;

	// ensure primed dir exists when not using redis
	if (!useRedis) {
		await fs.mkdir(PRIMED_DIR, { recursive: true });
	}

	// read top-level national dir for finra-individual-*.json and finra-firm-*.json
	const entries = await fs.readdir(NATIONAL);
	for (const name of entries) {
		const p = path.join(NATIONAL, name);
		if (name.startsWith('finra-individual-') && name.endsWith('.json')) {
			const id = name.replace('finra-individual-', '').replace('.json', '');
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const parsed = JSON.parse(raw);
				const key = finraIndividualKey(id);
				if (useRedis) {
					const exists = await redis.get(key);
					if (exists != null) {
						skipped++;
						continue;
					}
					await redis.set(key, JSON.stringify(parsed), { ex: TTL_SECONDS });
					written++;
				} else {
					primedBundles['finra-individual'][key] = parsed;
					written++;
				}
			} catch (err) {
				console.warn('failed to import', p, err?.message || err);
			}
		}

		if (name.startsWith('finra-firm-') && name.endsWith('.json')) {
			const id = name.replace('finra-firm-', '').replace('.json', '');
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const parsed = JSON.parse(raw);
				const key = finraFirmKey(id);
				if (useRedis) {
					const exists = await redis.get(key);
					if (exists != null) {
						skipped++;
						continue;
					}
					await redis.set(key, JSON.stringify(parsed), { ex: TTL_SECONDS });
					written++;
				} else {
					primedBundles['finra-firm'][key] = parsed;
					written++;
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
			const p = path.join(brokerDir, name);
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const parsed = JSON.parse(raw);
				const key = type === 'individual' ? finraIndividualKey(id) : finraFirmKey(id);
				if (useRedis) {
					const exists = await redis.get(key);
					if (exists != null) {
						skipped++;
						continue;
					}
					await redis.set(key, JSON.stringify(parsed), { ex: TTL_SECONDS });
					written++;
				} else {
					primedBundles[`finra-${type}`][key] = parsed;
					written++;
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
			const p = path.join(secDir, name);
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const parsed = JSON.parse(raw);
				const key = type === 'individual' ? `sec:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}` : `sec:firm:${id}:${DEFAULT_FIRM_QUERY}`;
				if (useRedis) {
					const exists = await redis.get(key);
					if (exists != null) {
						skipped++;
						continue;
					}
					await redis.set(key, JSON.stringify(parsed), { ex: TTL_SECONDS });
					written++;
				} else {
					primedBundles[`sec-${type}`][key] = parsed;
					written++;
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

	console.log(`import complete. written=${written} skipped=${skipped} usingRedis=${useRedis}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
