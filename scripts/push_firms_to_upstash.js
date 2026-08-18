#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// lightweight .env.local loader (avoid requiring dotenv)
function loadEnvFile(p) {
	try {
		const txt = fs.readFileSync(p, 'utf8');
		for (const line of txt.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const m = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/);
			if (!m) continue;
			let [, key, val] = m;
			// strip quotes
			if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
			if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
			process.env[key] = val;
		}
	} catch (e) {
		// ignore
	}
}
loadEnvFile(path.join(process.cwd(), '.env.local'));
const { Redis } = require('@upstash/redis');

const rawArgs = process.argv.slice(2);
const forceFlag = rawArgs.includes('--force') || rawArgs.includes('-f');
const ids = rawArgs.filter((a) => !a.startsWith('-'));
if (ids.length === 0) ids.push('10111', '39543');
const TTL = 60 * 60 * 24 * 30; // 30 days

function compressForRedis(str) {
	if (typeof str !== 'string') str = String(str);
	const rawByteLen = Buffer.byteLength(str, 'utf-8');
	if (rawByteLen <= 512) return { finalValue: str, compressed: false, byteLen: rawByteLen };
	const compressed = zlib.brotliCompressSync(Buffer.from(str, 'utf-8'));
	return { finalValue: 'br:' + compressed.toString('base64'), compressed: true, byteLen: compressed.length };
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	const allowWrites = String(process.env.UPSTASH_ALLOW_WRITES || '0');
	const force = forceFlag;
	if (allowWrites !== '1' && !force) {
		console.error('UPSTASH_ALLOW_WRITES is not enabled in .env.local — aborting. Re-run with --force to override.');
		process.exit(2);
	}
	if (!url || !token) {
		console.error('UPSTASH env vars required in .env.local');
		process.exit(1);
	}
	const redis = new Redis({ url, token });

	for (const id of ids) {
		try {
			const file = path.join(process.cwd(), 'data', 'national', `finra-firm-${id}.json`);
			if (!fs.existsSync(file)) {
				console.warn('missing file', file);
				continue;
			}
			const raw = fs.readFileSync(file, 'utf8');
			const key = `finra:firm:${id}:hl=true&wt=json`;
			const { finalValue, compressed, byteLen } = compressForRedis(raw);
			// Upstash set
			await redis.set(key, finalValue, { ex: TTL });
			console.log(`WROTE ${key} (bytes=${byteLen} compressed=${compressed})`);
		} catch (e) {
			console.error('FAILED', id, e?.message || e);
		}
	}
	if (redis) {
		try {
			if (typeof redis.disconnect === 'function') {
				await redis.disconnect();
			} else if (typeof redis.close === 'function') {
				await redis.close();
			}
		} catch (e) {}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
