#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function decompressIfBrotli(raw) {
	if (typeof raw !== 'string') return raw;
	if (raw.startsWith('br:')) {
		try {
			const buf = Buffer.from(raw.slice(3), 'base64');
			return zlib.brotliDecompressSync(buf).toString('utf8');
		} catch (e) {
			return null;
		}
	}
	return raw;
}

function isCandidateFile(name) {
	return /api\..+_search_(individual|firm)_([0-9]+)\.json$/.test(name);
}

async function findFiles(dir) {
	const results = [];
	async function walk(d) {
		const entries = await fs.promises.readdir(d, { withFileTypes: true });
		for (const ent of entries) {
			const p = path.join(d, ent.name);
			if (ent.isDirectory()) await walk(p);
			else if (ent.isFile() && isCandidateFile(ent.name)) results.push(p);
		}
	}
	await walk(dir);
	return results;
}

function keyForFile(filePath) {
	const parts = filePath.split(path.sep);
	// expect .../data/national/<folder>/<filename>
	const idx = parts.lastIndexOf('national');
	if (idx < 0 || parts.length < idx + 3) return null;
	const folder = parts[idx + 1];
	const filename = parts[parts.length - 1];
	const m = filename.match(/_search_(individual|firm)_([0-9]+)\.json$/);
	if (!m) return null;
	const type = m[1];
	const id = m[2];
	if (folder.includes('brokercheck.finra.org')) return `finra:${type}:${id}`;
	if (folder.includes('adviserinfo.sec.gov')) return `sec:${type}:${id}`;
	return null;
}

async function checkDiskFile(filePath) {
	try {
		const text = await fs.promises.readFile(filePath, 'utf8');
		const parsed = JSON.parse(text);
		const hits = parsed?.hits?.hits;
		if (!Array.isArray(hits)) return { ok: true };
		const errors = [];
		hits.forEach((h, idx) => {
			const src = h?._source || {};
			const content = src.content || src.iacontent || src.iaContent || null;
			if (typeof content === 'string') {
				try {
					JSON.parse(content);
				} catch (e) {
					errors.push({ index: idx, reason: 'invalid-json-in-_source.content' });
				}
			}
		});
		return { ok: errors.length === 0, errors };
	} catch (e) {
		return { ok: false, error: String(e.message || e) };
	}
}

async function getRedisClient() {
	// Prefer local ioredis when requested
	if (process.env.USE_LOCAL_REDIS === '1') {
		try {
			const IORedis = require('ioredis');
			return new IORedis('redis://127.0.0.1:6379');
		} catch (e) {
			console.error('ioredis not available', e.message || e);
			return null;
		}
	}
	// Try upstash
	const url = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL_2;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN_2;
	if (!url || !token) return null;
	try {
		const { Redis } = require('@upstash/redis');
		return new Redis({ url, token });
	} catch (e) {
		console.error('upstash client not available', e.message || e);
		return null;
	}
}

async function checkRedisKey(redis, key) {
	try {
		const raw = await redis.get(key);
		if (raw == null) return { exists: false };
		let text = raw;
		if (typeof text !== 'string') {
			try {
				text = JSON.stringify(text);
			} catch (e) {
				text = String(text);
			}
		}
		const decompressed = decompressIfBrotli(text);
		if (decompressed == null) return { exists: true, ok: false, reason: 'brotli-decompress-failed' };
		try {
			JSON.parse(decompressed);
			return { exists: true, ok: true };
		} catch (e) {
			return { exists: true, ok: false, reason: 'invalid-json' };
		}
	} catch (e) {
		return { exists: true, ok: false, error: String(e.message || e) };
	}
}

async function main() {
	const root = path.resolve(process.cwd(), 'data', 'national');
	console.log('Scanning disk cache under', root);
	const files = await findFiles(root);
	console.log('Found', files.length, 'candidate files');
	const results = [];
	for (const f of files) {
		const key = keyForFile(f);
		const disk = await checkDiskFile(f);
		results.push({ file: f, key, disk });
	}

	let redis = null;
	if (process.argv.includes('--redis')) {
		redis = await getRedisClient();
		if (!redis) console.warn('No Redis client available (make sure UPSTASH vars or USE_LOCAL_REDIS set)');
	}

	const report = [];
	for (const r of results) {
		const entry = { file: r.file, key: r.key, disk: r.disk };
		if (redis && r.key) {
			const redisRes = await checkRedisKey(redis, r.key);
			entry.redis = redisRes;
		}
		report.push(entry);
	}

	const malformed = report.filter((e) => (e.disk && e.disk.ok === false) || (e.redis && e.redis.ok === false));
	console.log('\nMalformed count:', malformed.length);
	malformed.forEach((m) => {
		console.log('\n- File:', m.file);
		if (m.key) console.log('  Redis key:', m.key);
		if (m.disk && m.disk.ok === false) console.log('  Disk issue:', m.disk.error || JSON.stringify(m.disk.errors));
		if (m.redis && m.redis.ok === false) console.log('  Redis issue:', m.redis.reason || m.redis.error);
	});

	const outPath = path.resolve(process.cwd(), 'tmp', 'malformed_crds_report.json');
	await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
	await fs.promises.writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2), 'utf8');
	console.log('\nWrote report to', outPath);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
