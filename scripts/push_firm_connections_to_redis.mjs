import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';
import fsExtra from 'fs';

async function main() {
	const firmId = process.argv[2];
	if (!firmId) {
		console.error('usage: node scripts/push_firm_connections_to_redis.mjs 107342');
		process.exit(2);
	}
	const file = path.join(process.cwd(), 'data', 'firm-connections', `${firmId}.json`);
	if (!fs.existsSync(file)) {
		console.error('file not found', file);
		process.exit(2);
	}
	const raw = fs.readFileSync(file, 'utf8');
	const cacheKey = `graph:firm-connections:v9:${firmId}`;
	const emptyKey = `${cacheKey}:empty`;

	// load .env files if present (allow local dev envs)
	function loadEnv(filePath) {
		try {
			for (const line of fsExtra.readFileSync(filePath, 'utf8').split(/\n/)) {
				const m = line.match(/^([^#=]+)=(.*)$/);
				if (!m) continue;
				const k = m[1].trim();
				let v = m[2].trim();
				if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
				if (!process.env[k]) process.env[k] = v;
			}
		} catch {}
	}
	loadEnv(path.join(process.cwd(), '.env.local'));
	loadEnv(path.join(process.cwd(), '.env'));

	// Prefer MIRROR env vars, fall back to legacy _2 names for compatibility
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token =
		process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN__2;
	if (!url || !token) {
		console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in env');
		process.exit(2);
	}
	const redis = new Redis({ url, token });

	try {
		await redis.set(cacheKey, raw, { ex: 60 * 60 * 24 * 30 });
		console.log('wrote', cacheKey);
		const emptyVal = await redis.get(emptyKey);
		if (emptyVal != null) {
			await redis.del(emptyKey);
			console.log('deleted', emptyKey);
		}
	} catch (e) {
		console.error('redis write error', e?.message || e);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
