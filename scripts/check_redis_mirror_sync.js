#!/usr/bin/env node
const { Redis } = require('@upstash/redis');

function makeClient(url, token) {
	if (!url || !token) return null;
	return new Redis({ url, token });
}

async function sampleClient(name, client) {
	if (!client) {
		console.log(`${name}: no config`);
		return null;
	}
	try {
		const dbsize = typeof client.dbsize === 'function' ? await client.dbsize() : null;
		// scan a sample of keys
		let cursor = '0';
		const sampledKeys = new Set();
		for (let i = 0; i < 3 && cursor !== '0'; i++) {
			const res = await client.scan(cursor, { COUNT: 100 });
			// Upstash returns ['cursor', [keys]] or { cursor, keys } depending on lib version
			if (Array.isArray(res)) {
				cursor = String(res[0] || '0');
				const keys = res[1] || [];
				keys.forEach((k) => sampledKeys.add(k));
			} else if (res && res.cursor != null) {
				cursor = String(res.cursor || '0');
				(res.keys || []).forEach((k) => sampledKeys.add(k));
			} else {
				break;
			}
			if (cursor === '0') break;
		}

		// If no iteration occurred, do one scan
		if (sampledKeys.size === 0) {
			try {
				const res = await client.scan('0', { COUNT: 100 });
				if (Array.isArray(res)) {
					(res[1] || []).forEach((k) => sampledKeys.add(k));
				} else if (res && res.keys) {
					(res.keys || []).forEach((k) => sampledKeys.add(k));
				}
			} catch (e) {
				// ignore
			}
		}

		const keys = Array.from(sampledKeys).slice(0, 200);
		let totalBytes = 0;
		if (keys.length) {
			// batch fetch values
			const vals = await client.mget(...keys);
			for (const v of vals) {
				if (v == null) continue;
				try {
					const s = typeof v === 'string' ? v : JSON.stringify(v);
					totalBytes += Buffer.byteLength(s, 'utf8');
				} catch (e) {
					// ignore
				}
			}
		}

		return { dbsize, sampledKeyCount: keys.length, sampledBytes: totalBytes };
	} catch (e) {
		console.error(`${name} error:`, e.message || e);
		return { error: String(e?.message || e) };
	}
}

async function main() {
	// If env vars aren't set in the shell, try to load from .env.local in project root
	if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
		try {
			const fs = require('fs');
			const path = require('path');
			const envPath = path.resolve(process.cwd(), '.env.local');
			if (fs.existsSync(envPath)) {
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
		} catch (e) {
			// ignore
		}
	}

	const url1 = process.env.UPSTASH_REDIS_REST_URL;
	const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
	const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
	const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2;

	const client1 = makeClient(url1, token1);
	const client2 = makeClient(url2, token2);

	console.log('Using env:');
	console.log(' UPSTASH_REDIS_REST_URL=', !!url1);
	console.log(' UPSTASH_REDIS_REST_URL_MIRROR=', !!url2);

	const a = await sampleClient('DB1', client1);
	const b = await sampleClient('DB2', client2);

	console.log('\nResults:');
	console.log('DB1:', a);
	console.log('DB2:', b);

	// Basic consistency hints
	if (a && b && !a.error && !b.error) {
		if (a.dbsize != null && b.dbsize != null) {
			console.log('\nDB dbsize comparison: DB1=', a.dbsize, 'DB2=', b.dbsize);
		}
		if (a.sampledKeyCount != null && b.sampledKeyCount != null) {
			console.log('Sampled keys fetched: DB1=', a.sampledKeyCount, 'DB2=', b.sampledKeyCount);
		}
		if (a.sampledBytes != null && b.sampledBytes != null) {
			console.log('Sampled bytes (approx): DB1=', a.sampledBytes, 'DB2=', b.sampledBytes);
		}
	}
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
