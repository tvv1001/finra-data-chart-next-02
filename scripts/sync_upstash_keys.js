#!/usr/bin/env node
/*
Safe one-shot Upstash key sync script

Usage (examples):
  # provide tokens via env for one-off use
  UPSTASH_SRC_URL="https://awake-dodo-..." UPSTASH_SRC_TOKEN="src" \
  UPSTASH_DST_URL="https://dashing-gator-..." UPSTASH_DST_TOKEN="dst" \
  node scripts/sync_upstash_keys.js --keys dashboard:cached-crd-count,dashboard:new-crds-cache

  # or pass flags
  node scripts/sync_upstash_keys.js \
    --src-url "https://awake-dodo-..." --src-token "src" \
    --dst-url "https://dashing-gator-..." --dst-token "dst" \
    --keys dashboard:cached-crd-count

Notes:
 - This script copies ONLY the explicit keys you name (no wildcards).
 - Tokens are read from environment variables or CLI flags and are never written to disk.
 - Use --yes to skip interactive confirmation.
 - After a successful copy consider rotating destination tokens for extra safety.
*/

const { argv, env, exit } = process;
const readline = require('readline');

function parseArgs() {
	const out = {};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.replace(/^--/, '');
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i++;
		} else {
			out[key] = true;
		}
	}
	return out;
}

function maskUrl(u) {
	try {
		const url = new URL(u);
		return `${url.protocol}//${url.hostname}`;
	} catch (err) {
		return u ? u.replace(/(:\/\/).*/, '$1...') : 'UNSET';
	}
}

async function promptYes(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (ans) => {
			rl.close();
			resolve(/^y(es)?$/i.test(ans.trim()));
		});
	});
}

async function main() {
	const args = parseArgs();

	const srcUrl = args['src-url'] || env.UPSTASH_SRC_URL || env.UPSTASH_REDIS_REST_URL;
	const srcToken = args['src-token'] || env.UPSTASH_SRC_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
	const dstUrl = args['dst-url'] || env.UPSTASH_DST_URL || env.UPSTASH_REDIS_REST_URL_MIRROR || env.UPSTASH_REDIS_REST_URL;
	const dstToken = args['dst-token'] || env.UPSTASH_DST_TOKEN || env.UPSTASH_REDIS_REST_TOKEN_MIRROR || env.UPSTASH_REDIS_REST_TOKEN;

	const keysArg = args['keys'] || env.SYNC_UPSTASH_KEYS;
	if (!keysArg) {
		console.error('Error: --keys must be provided (comma-separated list).');
		exit(2);
	}
	const keys = keysArg
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	if (!srcUrl || !srcToken) {
		console.error('Error: source URL/token not provided. Provide --src-url/--src-token or set UPSTASH_SRC_URL/UPSTASH_SRC_TOKEN.');
		exit(2);
	}
	if (!dstUrl || !dstToken) {
		console.error('Error: destination URL/token not provided. Provide --dst-url/--dst-token or set UPSTASH_DST_URL/UPSTASH_DST_TOKEN.');
		exit(2);
	}

	console.log('Preparing to copy the following keys from');
	console.log('  source:', maskUrl(srcUrl));
	console.log('  dest:  ', maskUrl(dstUrl));
	console.log('  keys:  ', keys.join(', '));

	if (!args.yes && !args['yes']) {
		const ok = await promptYes('Proceed with copy? (y/N) ');
		if (!ok) {
			console.log('Aborted. No changes made.');
			exit(0);
		}
	}

	// node >=18 provides global fetch; if not, fail with a helpful message
	if (typeof fetch !== 'function') {
		console.error('Error: global fetch is not available in this Node runtime. Use Node 18+ or run with a fetch polyfill.');
		exit(3);
	}

	for (const key of keys) {
		try {
			const getUrl = `${srcUrl.replace(/\/$/, '')}/get/${encodeURIComponent(key)}`;
			const res = await fetch(getUrl, { headers: { Authorization: `Bearer ${srcToken}` } });
			const json = await res.json();
			if (!('result' in json)) {
				console.warn(`Source GET for ${key} returned no result field, skipping:`, json);
				continue;
			}
			const payload = json.result;
			if (payload === null || payload === undefined) {
				console.warn(`Key ${key} exists on source but value is null/undefined; writing empty string to dest.`);
			}

			const setUrl = `${dstUrl.replace(/\/$/, '')}/set/${encodeURIComponent(key)}`;
			const isJsonLike = typeof payload === 'string' && /^[\[{]/.test(payload.trim());
			const headers = { Authorization: `Bearer ${dstToken}` };
			if (isJsonLike) headers['Content-Type'] = 'application/json';
			const body = payload === null || payload === undefined ? '' : String(payload);

			const setRes = await fetch(setUrl, { method: 'POST', headers, body });
			const setJson = await setRes.json().catch(() => null);
			if (setJson && setJson.result === 'OK') {
				console.log(`Copied ${key}: OK`);
			} else {
				console.warn(`Write for ${key} returned:`, setJson || (await setRes.text()));
			}
		} catch (err) {
			console.error(`Error copying key ${key}:`, err.message || err);
		}
	}

	console.log('Done. Consider rotating destination token if it was short-lived.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
