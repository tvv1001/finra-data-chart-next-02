import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';

function loadEnv(filePath) {
	try {
		for (const line of fs.readFileSync(filePath, 'utf8').split(/\n/)) {
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

const url = process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN__2;
if (!url || !token) {
	console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in env');
	process.exit(2);
}

const redis = new Redis({ url, token });

const args = process.argv.slice(2);
const opts = {
	dryRun: true,
	concurrency: 5,
	dir: path.join(process.cwd(), 'data', 'firm-connections'),
};
for (const a of args) {
	if (a === '--yes' || a === '--run') opts.dryRun = false;
	if (a.startsWith('--concurrency=')) opts.concurrency = Number(a.split('=')[1]) || opts.concurrency;
	if (a.startsWith('--dir=')) opts.dir = a.split('=')[1] || opts.dir;
}

async function pushFile(filePath) {
	const firmId = path.basename(filePath, '.json');
	const raw = fs.readFileSync(filePath, 'utf8');
	const cacheKey = `graph:firm-connections:v9:${firmId}`;
	const emptyKey = `${cacheKey}:empty`;
	if (opts.dryRun) {
		console.log('DRY:', firmId, filePath);
		return { firmId, ok: true, dry: true };
	}
	try {
		await redis.set(cacheKey, raw, { ex: 60 * 60 * 24 * 30 });
		const emptyVal = await redis.get(emptyKey);
		if (emptyVal != null) {
			await redis.del(emptyKey);
		}
		// audit entry
		try {
			const entry = { at: new Date().toISOString(), action: 'batch-push-firm-connections', firmId, ok: true, method: 'disk->redis' };
			await redis.lpush('dashboard:admin-audit', JSON.stringify(entry)).catch(() => null);
			await redis.ltrim('dashboard:admin-audit', 0, 999).catch(() => null);
			const logDir = path.join(process.cwd(), 'logs');
			fs.mkdirSync(logDir, { recursive: true });
			fs.appendFileSync(path.join(logDir, 'admin-audit.log'), JSON.stringify(entry) + '\n', 'utf8');
		} catch (e) {
			// ignore audit failures
		}
		console.log('wrote', cacheKey);
		return { firmId, ok: true };
	} catch (e) {
		console.error('error writing', cacheKey, e?.message || e);
		return { firmId, ok: false, reason: String(e?.message || e) };
	}
}

async function run() {
	if (!fs.existsSync(opts.dir)) {
		console.error('directory not found', opts.dir);
		process.exit(2);
	}
	const files = fs.readdirSync(opts.dir).filter((f) => f.endsWith('.json'));
	console.log('found', files.length, 'files in', opts.dir, 'dryRun=', opts.dryRun, 'concurrency=', opts.concurrency);
	const results = [];
	const pool = new Array(opts.concurrency).fill(Promise.resolve());
	let idx = 0;
	for (const file of files) {
		const fp = path.join(opts.dir, file);
		const slot = idx % opts.concurrency;
		pool[slot] = pool[slot]
			.then(() => pushFile(fp))
			.then((r) => results.push(r))
			.catch((e) => results.push({ firmId: file, ok: false, reason: String(e) }));
		idx++;
	}
	await Promise.all(pool);
	console.log('done. results:', results.length);
	const failed = results.filter((r) => !r.ok);
	if (failed.length) {
		console.error('failed:', failed.map((f) => `${f.firmId}:${f.reason}`).join(', '));
		process.exit(1);
	}
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
