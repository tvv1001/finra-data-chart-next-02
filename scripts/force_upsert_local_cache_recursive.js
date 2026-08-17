#!/usr/bin/env node
// Force-upsert all per-CRD keys by recursively scanning data/national and subdirs
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
const MAX_REQUEST_BYTES = 10_000_000;

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';
function finraIndividualKey(id) {
	return `finra:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`;
}
function finraFirmKey(id) {
	return `finra:firm:${id}:${DEFAULT_FIRM_QUERY}`;
}

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

async function walk(dir, cb) {
	const ents = await fs.readdir(dir, { withFileTypes: true });
	for (const e of ents) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			await walk(p, cb);
		} else if (e.isFile()) {
			await cb(p, e.name);
		}
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
	const limiter = new Bottleneck({ maxConcurrent: 5, minTime: 50 });

	let written = 0,
		failed = 0,
		processed = 0;

	console.log('Recursive force-upsert from', NATIONAL);

	const zlib = require('node:zlib');

	function compressForRedis(str) {
		if (typeof str !== 'string') str = String(str);
		const rawByteLen = Buffer.byteLength(str, 'utf-8');
		if (rawByteLen <= 512) return { finalValue: str, compressed: false, byteLen: rawByteLen };
		const compressed = zlib.brotliCompressSync(Buffer.from(str, 'utf-8'));
		return { finalValue: 'br:' + compressed.toString('base64'), compressed: true, byteLen: compressed.length };
	}

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

	const fileHandler = async (p, name) => {
		// patterns
		let m;
		if ((m = name.match(/^finra-individual-(\d+)\.json$/))) {
			const id = m[1];
			try {
				const raw = await fs.readFile(p, 'utf-8');
				limiter.schedule(() => setKey(finraIndividualKey(id), raw));
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
			return;
		}
		if ((m = name.match(/^finra-firm-(\d+)\.json$/))) {
			const id = m[1];
			try {
				const raw = await fs.readFile(p, 'utf-8');
				limiter.schedule(() => setKey(finraFirmKey(id), raw));
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
			return;
		}
		if ((m = name.match(/^api\.brokercheck\.finra\.org_search_(individual|firm)_(\d+)\.json$/))) {
			const type = m[1],
				id = m[2];
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const key = type === 'individual' ? finraIndividualKey(id) : finraFirmKey(id);
				limiter.schedule(() => setKey(key, raw));
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
			return;
		}
		if ((m = name.match(/^api\.adviserinfo\.sec\.gov_search_(individual|firm)_(\d+)\.json$/))) {
			const type = m[1],
				id = m[2];
			try {
				const raw = await fs.readFile(p, 'utf-8');
				const key = type === 'individual' ? finraIndividualKey(id) : finraFirmKey(id);
				limiter.schedule(() => setKey(key, raw));
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
			return;
		}
		// firm_123.json patterns found in subdirs
		if ((m = name.match(/^firm_(\d+)\.json$/))) {
			const id = m[1];
			try {
				const raw = await fs.readFile(p, 'utf-8');
				limiter.schedule(() => setKey(finraFirmKey(id), raw));
			} catch (err) {
				console.warn('READ_ERR', p, err?.message || err);
				failed++;
				processed++;
			}
			return;
		}
	};

	await walk(NATIONAL, fileHandler);

	await limiter.stop({ dropWaitingJobs: false });
	console.log('done. processed=', processed, 'written=', written, 'failed=', failed);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
