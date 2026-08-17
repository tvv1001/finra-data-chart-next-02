#!/usr/bin/env node
/*
 * Push local brokercheck/sec JSON files to Upstash with minimal writes.
 * - Batches keys and does MGET to fetch existing values
 * - Compresses payload with brotli and stores as 'br:<base64>' when >512 bytes
 * - Only issues SET for keys whose underlying JSON differs
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/push_minimal_batch.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');
const zlib = require('node:zlib');

const isDryRun = process.argv.includes('--dry-run');
const BATCH_KEYS = Number(process.env.BATCH_KEYS || 50);
const TTL = Number(process.env.TTL_SECONDS || 60 * 60 * 24);

function compressForRedis(str) {
	if (typeof str !== 'string') str = String(str);
	const rawByteLen = Buffer.byteLength(str, 'utf-8');
	if (rawByteLen <= 512) return { finalValue: str, compressed: false, byteLen: rawByteLen };
	const compressed = zlib.brotliCompressSync(Buffer.from(str, 'utf-8'));
	return { finalValue: 'br:' + compressed.toString('base64'), compressed: true, byteLen: compressed.length };
}

function decompressIfBr(val) {
	if (val == null) return null;
	if (typeof val !== 'string') return typeof val === 'object' ? JSON.stringify(val) : String(val);
	if (val.startsWith('br:')) {
		try {
			const buf = Buffer.from(val.slice(3), 'base64');
			return zlib.brotliDecompressSync(buf).toString('utf-8');
		} catch (e) {
			return val;
		}
	}
	return val;
}

function fileNameToRedisKey(fileName, source) {
	const match = /^api\.(?:brokercheck\.finra\.org|adviserinfo\.sec\.gov)_search_(individual|firm)_(\d{1,10})\.json$/i.exec(fileName);
	if (!match) return null;
	return `${source}:${match[1]}:${match[2]}`;
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('UPSTASH env vars required');
		process.exit(1);
	}
	const redis = new Redis({ url, token });

	const sources = [
		{ dir: path.join(process.cwd(), 'data', 'national', 'brokercheck.finra.org'), source: 'finra' },
		{ dir: path.join(process.cwd(), 'data', 'national', 'adviserinfo.sec.gov'), source: 'sec' },
	];

	let totalCandidates = 0,
		toWrite = 0,
		skipped = 0,
		errors = 0;

	for (const s of sources) {
		let files = [];
		try {
			files = fs.readdirSync(s.dir).filter((f) => f.endsWith('.json'));
		} catch (e) {
			console.warn('skip dir', s.dir);
			continue;
		}

		const items = files.map((f) => ({ file: f, key: fileNameToRedisKey(f, s.source), filePath: path.join(s.dir, f) })).filter(({ key }) => key !== null);

		totalCandidates += items.length;

		for (let i = 0; i < items.length; i += BATCH_KEYS) {
			const batch = items.slice(i, i + BATCH_KEYS);
			const keys = batch.map((it) => it.key);
			// read all files local
			const localMap = {};
			for (const it of batch) {
				try {
					const txt = fs.readFileSync(it.filePath, 'utf8');
					// validate JSON
					JSON.parse(txt);
					localMap[it.key] = txt;
				} catch (e) {
					console.warn('skip invalid local', it.filePath, e?.message || e);
				}
			}

			// fetch existing values via MGET
			let existing = [];
			try {
				existing = await redis.mget(...keys).catch(() => []);
			} catch (e) {
				console.warn('mget failed', e?.message || e);
				existing = [];
			}

			// determine which to write
			const writes = [];
			for (let idx = 0; idx < keys.length; idx++) {
				const key = keys[idx];
				const local = localMap[key];
				if (!local) continue;
				const existingVal = existing && existing[idx] != null ? existing[idx] : null;
				const existingStr = decompressIfBr(existingVal);
				const newStr = JSON.stringify(JSON.parse(local)); // normalized
				if (existingStr === newStr) {
					skipped++;
					continue;
				}
				const compressed = compressForRedis(newStr);
				writes.push({ key, value: compressed.finalValue });
			}

			if (writes.length === 0) continue;

			// perform writes (sequentially to avoid throttling; can be parallelized)
			for (const w of writes) {
				if (isDryRun) {
					console.log('[dry-run] would set', w.key);
					toWrite++;
					continue;
				}
				try {
					await redis.set(w.key, w.value, { ex: TTL });
					toWrite++;
				} catch (e) {
					console.warn('set failed', w.key, e?.message || e);
					errors++;
				}
			}
		}
	}

	console.log('done:', { totalCandidates, toWrite, skipped, errors });
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
