#!/usr/bin/env node
const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');

function loadEnvFallback() {
	const envPath = path.resolve(process.cwd(), '.env.local');
	if (!fs.existsSync(envPath)) return;
	const raw = fs.readFileSync(envPath, 'utf8');
	for (const line of raw.split(/\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*))\s*$/i);
		if (m) {
			const k = m[1];
			const v = m[2] ?? m[3] ?? m[4] ?? '';
			if (!process.env[k]) process.env[k] = v;
		}
	}
}

loadEnvFallback();

const url1 = process.env.UPSTASH_REDIS_REST_URL;
const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2;

if (String(process.env.UPSTASH_ALLOW_WRITES || '0') !== '1') {
	console.error('UPSTASH_ALLOW_WRITES !== 1; aborting. Set UPSTASH_ALLOW_WRITES=1 to permit deletions.');
	process.exit(3);
}

if (!url1 || !token1 || !url2 || !token2) {
	console.error('Missing primary or mirror Upstash configuration in env (UPSTASH_REDIS_REST_URL/_TOKEN and UPSTASH_REDIS_REST_URL_MIRROR/_TOKEN_MIRROR). Aborting.');
	process.exit(4);
}

const primary = new Redis({ url: url1, token: token1 });
const mirror = new Redis({ url: url2, token: token2 });

async function main() {
	console.log('Starting DB1 -> mirror sync deletion. This will delete keys from primary that are not present in the mirror.');
	const batchCheck = 200; // keys to check existence per call
	const delChunk = 200; // keys to delete per del call
	let scanned = 0;
	let toDeleteCount = 0;
	let deleted = 0;

	let cursor = '0';
	do {
		const res = await primary.scan(cursor, { COUNT: 1000 });
		let keys = [];
		if (Array.isArray(res)) {
			cursor = String(res[0] || '0');
			keys = res[1] || [];
		} else if (res && res.cursor != null) {
			cursor = String(res.cursor || '0');
			keys = res.keys || [];
		} else {
			break;
		}

		scanned += keys.length;

		// process keys in slices
		for (let i = 0; i < keys.length; i += batchCheck) {
			const slice = keys.slice(i, i + batchCheck);
			try {
				const exists = await mirror.mget(...slice).catch(() => null);
				const missing = [];
				if (Array.isArray(exists)) {
					for (let j = 0; j < exists.length; j++) {
						if (exists[j] == null) missing.push(slice[j]);
					}
				} else {
					// fallback: call exists per key
					for (const k of slice) {
						try {
							const ex = await mirror.exists(k).catch(() => 0);
							if (!ex) missing.push(k);
						} catch {}
					}
				}

				toDeleteCount += missing.length;
				// delete in chunks
				for (let d = 0; d < missing.length; d += delChunk) {
					const delSlice = missing.slice(d, d + delChunk);
					try {
						await primary.del(...delSlice).catch((e) => {
							console.error('del error:', e?.message || e);
						});
						deleted += delSlice.length;
					} catch (e) {
						console.error('delete chunk error', e?.message || e);
					}
				}
			} catch (e) {
				console.error('compare batch error', e?.message || e);
			}
		}

		console.log(`scanned=${scanned} queued_for_delete=${toDeleteCount} deleted=${deleted}`);
	} while (cursor !== '0');

	console.log('Deletion pass complete. scanned=', scanned, 'deleted=', deleted, 'would-have-deleted=', toDeleteCount);
	console.log('Running mirror-check to summarize sizes...');
	// run quick size check
	try {
		const db1size = await primary.dbsize().catch(() => null);
		const db2size = await mirror.dbsize().catch(() => null);
		console.log('DB sizes after deletion: DB1=', db1size, 'DB2=', db2size);
	} catch (e) {
		console.error('dbsize check failed', e?.message || e);
	}
}

main().catch((e) => {
	console.error('Fatal error', e?.message || e);
	process.exit(2);
});
