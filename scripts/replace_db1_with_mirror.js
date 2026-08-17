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
	console.error('UPSTASH_ALLOW_WRITES !== 1; aborting. Set UPSTASH_ALLOW_WRITES=1 to permit destructive replace.');
	process.exit(3);
}

if (!url1 || !token1 || !url2 || !token2) {
	console.error('Missing primary or mirror Upstash configuration in env. Aborting.');
	process.exit(4);
}

const primary = new Redis({ url: url1, token: token1 });
const mirror = new Redis({ url: url2, token: token2 });

async function scanAllKeys(client, count = 1000) {
	const out = [];
	let cursor = '0';
	do {
		const res = await client.scan(cursor, { COUNT: count });
		if (Array.isArray(res)) {
			cursor = String(res[0] || '0');
			const keys = res[1] || [];
			out.push(...keys);
		} else if (res && res.cursor != null) {
			cursor = String(res.cursor || '0');
			out.push(...(res.keys || []));
		} else {
			break;
		}
	} while (cursor !== '0');
	return out;
}

async function main() {
	console.log('Flushing primary DB1 and copying all keys from mirror to primary. This is destructive.');

	console.log('Flushing primary DB1...');
	try {
		await primary.flushdb();
	} catch (e) {
		console.error('flushdb failed:', e?.message || e);
		process.exit(5);
	}

	console.log('Scanning mirror for keys...');
	const keys = await scanAllKeys(mirror, 1000);
	console.log('Mirror keys to copy:', keys.length);

	const batch = 200;
	let copied = 0;
	for (let i = 0; i < keys.length; i += batch) {
		const slice = keys.slice(i, i + batch);
		// fetch values and TTLs
		const values = await mirror.mget(...slice).catch(() => null);
		// try to fetch TTLs where possible
		const ttls = await Promise.all(slice.map((k) => mirror.ttl(k).catch(() => -1)));

		if (!Array.isArray(values)) {
			// fall back to individual gets
			for (let j = 0; j < slice.length; j++) {
				const key = slice[j];
				const v = await mirror.get(key).catch(() => null);
				const ttl = await mirror.ttl(key).catch(() => -1);
				try {
					if (v == null) continue;
					if (typeof ttl === 'number' && ttl > 0) {
						await primary.set(key, v, { ex: ttl });
					} else {
						await primary.set(key, v);
					}
					copied++;
				} catch (e) {
					console.error('set error for key', key, e?.message || e);
				}
			}
		} else {
			for (let j = 0; j < slice.length; j++) {
				const key = slice[j];
				const v = values[j];
				const ttl = Number.isFinite(Number(ttls[j])) ? ttls[j] : -1;
				try {
					if (v == null) continue;
					if (ttl > 0) {
						await primary.set(key, v, { ex: ttl });
					} else {
						await primary.set(key, v);
					}
					copied++;
				} catch (e) {
					console.error('set error for key', key, e?.message || e);
				}
			}
		}
		console.log(`copied ${copied}/${keys.length}`);
	}

	console.log('Copy complete. Verifying sizes...');
	const db1 = await primary.dbsize().catch(() => null);
	const db2 = await mirror.dbsize().catch(() => null);
	console.log('DB sizes after replace: DB1=', db1, 'DB2=', db2);
}

main().catch((e) => {
	console.error('Fatal:', e?.message || e);
	process.exit(1);
});
