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

// prefer MIRROR vars, fall back to legacy _2 names
const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
const token =
	process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN__2;
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

async function pushBatch(filePaths) {
	const items = filePaths.map((fp) => {
		const firmId = path.basename(fp, '.json');
		const raw = fs.readFileSync(fp, 'utf8');
		const cacheKey = `graph:firm-connections:v9:${firmId}`;
		const emptyKey = `${cacheKey}:empty`;
		return { firmId, fp, raw, cacheKey, emptyKey };
	});

	if (opts.dryRun) {
		for (const it of items) console.log('DRY:', it.firmId, it.fp);
		return items.map((it) => ({ firmId: it.firmId, ok: true, dry: true }));
	}

	try {
		// Build mset args: [key1, val1, key2, val2, ...]
		const msetArgs = [];
		for (const it of items) {
			msetArgs.push(it.cacheKey, it.raw);
		}

		// Use mset to write all values in one request
		if (msetArgs.length > 0) {
			await redis.mset(...msetArgs);
		}

		// Set TTLs in parallel (expire) to avoid per-set EX overhead
		const expires = items.map((it) => redis.expire(it.cacheKey, 60 * 60 * 24 * 30).catch(() => null));
		await Promise.all(expires);

		// Cleanup any :empty keys via mget -> del batch
		const emptyKeys = items.map((it) => it.emptyKey);
		if (emptyKeys.length > 0) {
			try {
				const emptyVals = await redis.mget(...emptyKeys);
				const toDel = [];
				for (let i = 0; i < emptyKeys.length; i++) {
					if (emptyVals && emptyVals[i] != null) toDel.push(emptyKeys[i]);
				}
				if (toDel.length > 0) await redis.del(...toDel).catch(() => null);
			} catch {}
		}

		// Batch audit: push one audit entry per firm in a single lpush
		try {
			const entries = items.map((it) =>
				JSON.stringify({ at: new Date().toISOString(), action: 'batch-push-firm-connections', firmId: it.firmId, ok: true, method: 'disk->redis' }),
			);
			if (entries.length) {
				await redis.lpush('dashboard:admin-audit', ...entries).catch(() => null);
				await redis.ltrim('dashboard:admin-audit', 0, 999).catch(() => null);
				const logDir = path.join(process.cwd(), 'logs');
				fs.mkdirSync(logDir, { recursive: true });
				for (const e of entries) fs.appendFileSync(path.join(logDir, 'admin-audit.log'), e + '\n', 'utf8');
			}
		} catch (e) {
			// ignore audit failures
		}

		for (const it of items) console.log('wrote', it.cacheKey);
		return items.map((it) => ({ firmId: it.firmId, ok: true }));
	} catch (e) {
		for (const it of items) console.error('error writing', it.cacheKey, e?.message || e);
		return items.map((it) => ({ firmId: it.firmId, ok: false, reason: String(e?.message || e) }));
	}
}

async function run() {
	if (!fs.existsSync(opts.dir)) {
		console.error('directory not found', opts.dir);
		process.exit(2);
	}
	const files = fs.readdirSync(opts.dir).filter((f) => f.endsWith('.json'));
	console.log('found', files.length, 'files in', opts.dir, 'dryRun=', opts.dryRun, 'concurrency=', opts.concurrency);
	const batchSize = Number(process.env.PUSH_BATCH_SIZE || 50);
	const results = [];
	// Build batches
	const batches = [];
	for (let i = 0; i < files.length; i += batchSize) {
		batches.push(files.slice(i, i + batchSize));
	}

	console.log('found', files.length, 'files in', opts.dir, 'dryRun=', opts.dryRun, 'concurrency=', opts.concurrency, 'batches=', batches.length, 'batchSize=', batchSize);

	const pool = new Array(Math.max(1, opts.concurrency)).fill(Promise.resolve());
	let bi = 0;
	for (const batch of batches) {
		const fpBatch = batch.map((f) => path.join(opts.dir, f));
		const slot = bi % pool.length;
		pool[slot] = pool[slot]
			.then(() => pushBatch(fpBatch))
			.then((rs) => rs.forEach((r) => results.push(r)))
			.catch((e) => fpBatch.forEach((f) => results.push({ firmId: path.basename(f), ok: false, reason: String(e) })));
		bi++;
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
