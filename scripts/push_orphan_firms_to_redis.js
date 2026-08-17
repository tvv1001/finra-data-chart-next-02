#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Redis: UpstashRedis } = require('@upstash/redis');
const IORedis = require('ioredis');

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

const ORPHAN_DIR = path.join(process.cwd(), 'data', 'national', 'orphan_firms');

const TARGET_CRDS = [
	'105316',
	'106807',
	'108446',
	'109903',
	'110778',
	'113037',
	'116280',
	'117031',
	'118381',
	'118669',
	'119755',
	'122999',
	'123637',
	'123903',
	'133890',
	'139233',
	'2837',
	'541',
	'67',
];

const UPSTASH_ALLOW_WRITES = String(process.env.UPSTASH_ALLOW_WRITES || '0');
if (UPSTASH_ALLOW_WRITES !== '1') {
	console.error('UPSTASH_ALLOW_WRITES !== 1; aborting Upstash writes. Set UPSTASH_ALLOW_WRITES=1 in .env.local to permit writes.');
}

const localRedis = new IORedis(process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379');

const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const upstashMirrorUrl = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
const upstashMirrorToken = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2;

const upstash = upstashUrl && upstashToken ? new UpstashRedis({ url: upstashUrl, token: upstashToken }) : null;
const upstashMirror = upstashMirrorUrl && upstashMirrorToken ? new UpstashRedis({ url: upstashMirrorUrl, token: upstashMirrorToken }) : null;

async function pushOne(crd) {
	const fname = `api.orphan_firm_${crd}.json`;
	const p = path.join(ORPHAN_DIR, fname);
	if (!fs.existsSync(p)) {
		console.warn('Missing orphan file for CRD', crd, p);
		return { crd, ok: false, reason: 'missing_file' };
	}
	const raw = fs.readFileSync(p, 'utf8');
	let parsed = null;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		parsed = raw;
	}
	const val = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
	const key = `finra:firm:${crd}`;

	// write to local redis
	try {
		await localRedis.set(key, val);
	} catch (e) {
		console.error('Local redis set failed for', key, e?.message || e);
		return { crd, ok: false, reason: 'local_set_failed' };
	}

	// write to Upstash primary/mirror if allowed
	if (upstash && UPSTASH_ALLOW_WRITES === '1') {
		try {
			await upstash.set(key, val);
		} catch (e) {
			console.error('Upstash primary set failed for', key, e?.message || e);
			return { crd, ok: false, reason: 'upstash_primary_failed' };
		}
		if (upstashMirror) {
			try {
				await upstashMirror.set(key, val);
			} catch (e) {
				console.error('Upstash mirror set failed for', key, e?.message || e);
			}
		}
	}

	return { crd, ok: true };
}

async function main() {
	console.log('Pushing orphan firm CRDs to local Redis and Upstash (if enabled).');
	const results = [];
	for (const crd of TARGET_CRDS) {
		process.stdout.write(`Processing ${crd}... `);
		const res = await pushOne(crd);
		results.push(res);
		console.log(res.ok ? 'OK' : `FAILED (${res.reason})`);
	}

	const ok = results.filter((r) => r.ok).length;
	console.log(`Completed. ${ok}/${results.length} succeeded.`);
	await localRedis.quit();
	process.exit(0);
}

main().catch((e) => {
	console.error('Fatal:', e?.message || e);
	process.exit(1);
});
