#!/usr/bin/env node
// Force-upsert all per-CRD keys from local national dump into Upstash Redis (OVERWRITE)
const fs = require('node:fs/promises');
const path = require('node:path');
const { Redis } = require('@upstash/redis');
const Bottleneck = require('bottleneck');

const ROOT = process.cwd();
const EXTERNAL_LOCAL = process.env.LOCAL_DATA_DIR || '/home/lenny/Dev/Data/national';
const fsSync = require('node:fs');
let NATIONAL;
try {
	fsSync.accessSync(EXTERNAL_LOCAL);
	NATIONAL = EXTERNAL_LOCAL;
} catch {
	NATIONAL = path.join(ROOT, 'data', 'national');
}

const TTL_SECONDS = 60 * 60 * 24; // 1 day
const REPORT_INTERVAL = 500;
const MAX_REQUEST_BYTES = 10_000_000; // Upstash limit ~10,485,760 - be conservative

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';
function isValidCrd(value) {
	return typeof value === 'string' && /^\d+$/.test(value.trim());
}
function finraIndividualKey(id) {
	const s = String(id || '').trim();
	if (!isValidCrd(s)) throw new Error(`invalid individual id: ${id}`);
	return `finra:individual:${s}:${DEFAULT_INDIVIDUAL_QUERY}`;
}
function finraFirmKey(id) {
	const s = String(id || '').trim();
	if (!isValidCrd(s)) throw new Error(`invalid firm id: ${id}`);
	return `finra:firm:${s}:${DEFAULT_FIRM_QUERY}`;
}

// detect broker/search empty hits responses
function isEmptyHits(rawStr) {
	try {
		const obj = JSON.parse(rawStr);
		if (!obj || !obj.hits) return false;
		const h = obj.hits;
		const total = h.total;
		const totalVal = typeof total === 'number' ? total : total && total.value;
		if (totalVal === 0 && Array.isArray(h.hits) && h.hits.length === 0) return true;
	} catch (e) {
		return false;
	}
	return false;
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
	if (!url || !token) {
		console.error('UPSTASH env vars required');
		process.exit(1);
	}
	const redis = new Redis({ url, token });

	// limiter: concurrency 5, minTime 50ms
	const limiter = new Bottleneck({ maxConcurrent: 5, minTime: 50 });

	let written = 0,
		failed = 0,
		processed = 0;

	console.log('Force-upsert from', NATIONAL);

	const zlib = require('node:zlib');

	function compressForRedis(str) {
		if (typeof str !== 'string') str = String(str);
		const rawByteLen = Buffer.byteLength(str, 'utf-8');
		if (rawByteLen <= 512) return { finalValue: str, compressed: false, byteLen: rawByteLen };
		const compressed = zlib.brotliCompressSync(Buffer.from(str, 'utf-8'));
		return { finalValue: 'br:' + compressed.toString('base64'), compressed: true, byteLen: compressed.length };
	}

	// helper to set key safely
	async function setKey(key, contentStr) {
		// skip obvious empty search results
		if (isEmptyHits(contentStr)) {
			console.log('SKIP_EMPTY_HITS', key);
			processed++;
			if (processed % REPORT_INTERVAL === 0) console.log(`progress processed=${processed} written=${written} failed=${failed}`);
			return;
		}
		const compressed = compressForRedis(contentStr);
		if (compressed.byteLen > MAX_REQUEST_BYTES) {
			console.warn('SKIP_TOO_LARGE', key, 'bytes=', compressed.byteLen);
			failed++;
			processed++;
			return;
		}
		try {
			await redis.set(key, compressed.finalValue, { ex: TTL_SECONDS });
			written++;
		} catch (err) {
			console.warn('SET_FAILED', key, err?.message || err);
			failed++;
		}
		processed++;
		if (processed % REPORT_INTERVAL === 0) console.log(`progress processed=${processed} written=${written} failed=${failed}`);
	}

	// scan top-level files
	const ents = await fs.readdir(NATIONAL);
	for (const name of ents) {
		const p = path.join(NATIONAL, name);
		if (name.startsWith('finra-individual-') && name.endsWith('.json')) {
			const id = name.replace('finra-individual-', '').replace('.json', '');
			try {
				const raw = await fs.readFile(p, 'utf-8');
				try {
					limiter.schedule(() => setKey(finraIndividualKey(id), raw));
				} catch (e) {
					console.warn('INVALID_CLEARED', id, e?.message || e);
					failed++;
					processed++;
				}
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
		}
		if (name.startsWith('finra-firm-') && name.endsWith('.json')) {
			const id = name.replace('finra-firm-', '').replace('.json', '');
			try {
				const raw = await fs.readFile(p, 'utf-8');
				try {
					limiter.schedule(() => setKey(finraFirmKey(id), raw));
				} catch (e) {
					console.warn('INVALID_CLEARED', id, e?.message || e);
					failed++;
					processed++;
				}
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
		}
	}

	// brokercheck.finra.org
	const brokerDir = path.join(NATIONAL, 'brokercheck.finra.org');
	if (await fileExists(brokerDir)) {
		const bents = await fs.readdir(brokerDir);
		for (const name of bents) {
			let id, type;
			if (name.startsWith('firm_') && name.endsWith('.json')) {
				type = 'firm';
				id = name.replace('firm_', '').replace('.json', '');
			} else {
				const m = name.match(/^api\.brokercheck\.finra\.org_search_(individual|firm)_(\d+)\.json$/);
				if (m) {
					type = m[1];
					id = m[2];
				}
			}
			if (!type || !id) continue;
			const p = path.join(brokerDir, name);
			try {
				const raw = await fs.readFile(p, 'utf-8');
				try {
					const key = type === 'individual' ? finraIndividualKey(id) : finraFirmKey(id);
					limiter.schedule(() => setKey(key, raw));
				} catch (e) {
					console.warn('INVALID_CLEARED', id, e?.message || e);
					failed++;
					processed++;
				}
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
		}
	}

	// adviserinfo.sec.gov
	const secDir = path.join(NATIONAL, 'adviserinfo.sec.gov');
	if (await fileExists(secDir)) {
		const sents = await fs.readdir(secDir);
		for (const name of sents) {
			let id, type;
			if (name.startsWith('firm_') && name.endsWith('.json')) {
				type = 'firm';
				id = name.replace('firm_', '').replace('.json', '');
			} else {
				const m = name.match(/^api\.adviserinfo\.sec\.gov_search_(individual|firm)_(\d+)\.json$/);
				if (m) {
					type = m[1];
					id = m[2];
				}
			}
			if (!type || !id) continue;
			const p = path.join(secDir, name);
			try {
				const raw = await fs.readFile(p, 'utf-8');
				try {
					const key = type === 'individual' ? finraIndividualKey(id) : finraFirmKey(id);
					limiter.schedule(() => setKey(key, raw));
				} catch (e) {
					console.warn('INVALID_CLEARED', id, e?.message || e);
					failed++;
					processed++;
				}
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
		}
	}

	// wait for limiter to finish
	await limiter.stop({ dropWaitingJobs: false });

	console.log('done. processed=', processed, 'written=', written, 'failed=', failed);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
