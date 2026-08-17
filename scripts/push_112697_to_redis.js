#!/usr/bin/env node
// Push data/firm-connections/112697-docs.json into Upstash Redis at key finra:firm:112697
const fs = require('node:fs/promises');
const path = require('node:path');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'data', 'firm-connections', '112697-docs.json');
const crd = '112697';
function isValidCrd(value) {
	return typeof value === 'string' && /^\d+$/.test(value.trim());
}
if (!isValidCrd(crd)) {
	console.error('invalid CRD', crd);
	process.exit(4);
}
const KEY = `finra:firm:${crd}`;
const TTL_SECONDS = 60 * 60 * 24; // 1 day
const zlib = require('node:zlib');
const MAX_REQUEST_BYTES = 10_000_000;

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('UPSTASH env vars required: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
		process.exit(1);
	}
	const redis = new Redis({ url, token });
	try {
		const raw = await fs.readFile(FILE, 'utf-8');
		// compress with brotli if large enough to match repo behavior
		let finalValue = raw;
		try {
			if (raw.length > 512) {
				finalValue = 'br:' + zlib.brotliCompressSync(Buffer.from(raw)).toString('base64');
			}
		} catch (e) {
			console.warn('brotli failed, falling back to raw payload', e?.message || e);
			finalValue = raw;
		}

		const finalBytes = Buffer.byteLength(finalValue, 'utf-8');
		console.log('Final payload bytes (post-compress if applied):', finalBytes);
		if (finalBytes > MAX_REQUEST_BYTES) {
			console.error('Payload too large after compression, aborting. bytes=', finalBytes);
			process.exit(2);
		}
		await redis.set(KEY, finalValue, { ex: TTL_SECONDS });
		console.log('WROTE', KEY);
	} catch (err) {
		console.error('ERROR', err?.message || err);
		process.exit(3);
	}
}

main();
