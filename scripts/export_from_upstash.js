#!/usr/bin/env node
/*
 * export_from_upstash.js
 * Fetch keys from Upstash Redis and merge them into the local data dump and
 * project primed-cache (writes JSON + gzipped .bin), without writing back to Upstash.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const fsSync = require('node:fs');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();
const EXTERNAL_LOCAL = process.env.LOCAL_DATA_DIR || '/home/lenny/Dev/Data/national';
let NATIONAL;
try {
	fsSync.accessSync(EXTERNAL_LOCAL);
	NATIONAL = EXTERNAL_LOCAL;
} catch {
	NATIONAL = path.join(ROOT, 'data', 'national');
}
const PRIMED_DIR = path.join(NATIONAL, 'primed-cache');
const PROJECT_PRIMED_DIR = path.join(ROOT, 'data', 'national', 'primed-cache');

async function fileExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

function normalizeIdFromKey(key) {
	// key format: prefix:type:id:query
	const parts = key.split(':');
	return parts[2] || null;
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('UPSTASH env vars missing. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
		process.exit(2);
	}
	const redis = new Redis({ url, token });

	// collect keys
	console.log('scanning keys from Upstash (cursor-scan, permission-safe)...');
	async function scanMatch(pattern) {
		let cursor = '0';
		const found = [];
		while (true) {
			// try multiple call shapes to be resilient to client versions
			let res;
			try {
				res = await redis.scan(cursor, { MATCH: pattern, COUNT: 1000 });
			} catch (e) {
				// fallback to variadic args
				res = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '1000');
			}

			let nextCursor;
			let keys;
			if (Array.isArray(res)) {
				nextCursor = String(res[0]);
				keys = res[1] || [];
			} else if (res && typeof res === 'object' && ('cursor' in res || 'keys' in res)) {
				nextCursor = String(res.cursor || res[0] || '0');
				keys = res.keys || res[1] || [];
			} else {
				break;
			}

			for (const k of keys) found.push(k);
			if (nextCursor === '0' || nextCursor === 0) break;
			cursor = nextCursor;
		}
		return found;
	}

	const finraKeys = await scanMatch('finra:*');
	const secKeys = await scanMatch('sec:*');
	const keys = Array.from(new Set([...(finraKeys || []), ...(secKeys || [])]));
	console.log('found keys=', keys.length);

	const primedBundles = {
		'finra-individual': {},
		'sec-individual': {},
	};

	let writtenFiles = 0;

	// ensure directories exist
	await fs.mkdir(NATIONAL, { recursive: true });
	await fs.mkdir(PRIMED_DIR, { recursive: true });
	await fs.mkdir(PROJECT_PRIMED_DIR, { recursive: true });

	for (const key of keys) {
		try {
			const val = await redis.get(key);
			if (val == null) continue;
			let parsed;
			try {
				parsed = JSON.parse(val);
			} catch (err) {
				// sometimes stored values may already be objects; if so, use directly
				parsed = val;
			}

			if (key.startsWith('finra:individual:')) {
			const id = normalizeIdFromKey(key);
			if (!id) continue;
			const outPath = path.join(NATIONAL, `finra-individual-${id}.json`);
			let existing = {};
			if (await fileExists(outPath)) {
				try {
					existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) || {};
				} catch {}
			}
			const merged = { ...existing, ...parsed };
			await fs.writeFile(outPath, JSON.stringify(merged), 'utf-8');
			primedBundles['finra-individual'][key] = merged;
			writtenFiles++;
		} else if (key.startsWith('sec:individual:')) {
			const id = normalizeIdFromKey(key);
			if (!id) continue;
			const outDir = path.join(NATIONAL, 'adviserinfo.sec.gov');
			await fs.mkdir(outDir, { recursive: true });
			const outPath = path.join(outDir, `individual_${id}.json`);
			let existing = {};
			if (await fileExists(outPath)) {
				try {
					existing = JSON.parse(await fs.readFile(outPath, 'utf-8')) || {};
				} catch {}
			}
			const merged = { ...existing, ...parsed };
			await fs.writeFile(outPath, JSON.stringify(merged), 'utf-8');
			primedBundles['sec-individual'][key] = merged;
			writtenFiles++;
		} else {
			// skip unknown key
		}
		} catch (err) {
			console.warn('failed key', key, err?.message || err);
		}
	}

	// write primed bundles into PRIMED_DIR and project primed-cache (.bin)
	const zlib = require('node:zlib');
	for (const [name, obj] of Object.entries(primedBundles)) {
		try {
			const out = path.join(PRIMED_DIR, `${name}.json`);
			let existing = {};
			if (await fileExists(out)) {
				try {
					existing = JSON.parse(await fs.readFile(out, 'utf-8')) || {};
				} catch {}
			}
			const merged = { ...existing, ...obj };
			await fs.writeFile(out, JSON.stringify(merged), 'utf-8');

			// write project gzipped bin
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
			await fs.writeFile(projectOutJson, JSON.stringify(mergedProj), 'utf-8');
		} catch (err) {
			console.warn('failed to write primed bundle', name, err?.message || err);
		}
	}

	console.log(`export complete. keys_fetched=${keys.length} files_written=${writtenFiles}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
