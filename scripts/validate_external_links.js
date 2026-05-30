#!/usr/bin/env node
/*
Validate external FINRA / SEC summary URLs for nodes in data/national/finra-graph.json.
- Writes a report to data/national/external_link_validation_<timestamp>.json
- Use --apply to update the graph file and clear hasFinraPage/hasSecPage for unreachable links (creates a backup).

Cron-friendly: exits with 0 on success, non-zero on fatal errors.
*/

const fs = require('fs').promises;
const { assertExternalApisEnabled } = require('./external-control');

// Respect global disable switch
assertExternalApisEnabled('validate_external_links.js');
const path = require('path');
const zlib = require('zlib');

const GRAPH_PATH = path.resolve(__dirname, '../data/national/finra-graph.json');
const OUT_DIR = path.resolve(__dirname, '../data/national');
const TIMEOUT_MS = 15000;
const CONCURRENCY = 6;
const MAX_ATTEMPTS = 3; // number of attempts per endpoint before declaring unreachable
const RETRY_DELAY_MS = 1500;
// Upstash/Redis integration (optional): configure REST endpoint and token
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || null;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;
const CONFIRM_THRESHOLD = parseInt(process.env.VALIDATE_CONFIRM_THRESHOLD || '2', 10);
const KEY_PREFIX = 'validate:link:';
const TRANSIENT_ABORT_PERCENT = parseInt(process.env.VALIDATE_TRANSIENT_ABORT_PERCENT || '50', 10);

function nowIso() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

async function safeFetch(url, timeout = TIMEOUT_MS) {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeout);
	try {
		const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
		const text = await res.text();
		clearTimeout(id);
		return { ok: res.ok, status: res.status, body: text };
	} catch (err) {
		clearTimeout(id);
		return { ok: false, status: null, error: String(err) };
	}
}

async function retryFetch(url, attempts = MAX_ATTEMPTS) {
	let last = null;
	for (let i = 0; i < attempts; i++) {
		last = await safeFetch(url);
		if (last.ok) return { result: last, attempts: i + 1 };
		// treat 4xx that are not 401/403 as definitive (no need to retry)
		if (last.status && last.status >= 400 && last.status < 500 && last.status !== 401 && last.status !== 403) {
			return { result: last, attempts: i + 1 };
		}
		// otherwise wait and retry
		await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
	}
	return { result: last, attempts: attempts };
}

function isBrokercheckError(body) {
	if (!body) return false;
	return body.includes('There was a problem processing your request') || body.includes('BrokerCheck is temporarily unavailable');
}

// Redis / Upstash helper: set a value for a key and optionally set expiry.
// If isBinary is true, `value` must be a base64-encoded string. We also write a companion
// metadata key `${key}:meta` with JSON { binary: true, encoding: 'base64' } so readers can detect it.
// meta: optional object stored alongside the key as `${key}:meta` (JSON)
async function redisSetKey(key, value, expireSeconds = 2592000, meta = null) {
	if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
	try {
		// store the main value (value should be safe to URI-encode)
		await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
		});
		// set metadata if provided
		if (meta) {
			const metaStr = JSON.stringify(meta);
			try {
				await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key + ':meta')}/${encodeURIComponent(metaStr)}`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
				});
			} catch (e) {}
		}
		try {
			await fetch(`${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${expireSeconds}`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
			});
			if (meta) {
				try {
					await fetch(`${UPSTASH_URL}/expire/${encodeURIComponent(key + ':meta')}/${expireSeconds}`, {
						method: 'POST',
						headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
					});
				} catch (e) {}
			}
		} catch (e) {}
		return true;
	} catch (e) {
		return false;
	}
}

async function saveLocalApiCache(key, value, isBinary = false, meta = null) {
	try {
		const cacheDir = path.join(OUT_DIR, 'api_cache');
		await fs.mkdir(cacheDir, { recursive: true });
		if (isBinary) {
			const file = path.join(cacheDir, `${encodeURIComponent(key)}.bin`);
			const buf = Buffer.from(value, 'base64');
			await fs.writeFile(file, buf);
			// write meta
			const metaFile = path.join(cacheDir, `${encodeURIComponent(key)}:meta.json`);
			const metaObj = Object.assign({ binary: true, encoding: 'base64', writtenAt: new Date().toISOString() }, meta || {});
			await fs.writeFile(metaFile, JSON.stringify(metaObj, null, 2), 'utf8');
			return true;
		}
		const file = path.join(cacheDir, `${encodeURIComponent(key)}.json`);
		// try to write pretty JSON when possible
		let out = value;
		try {
			const parsed = JSON.parse(value);
			out = JSON.stringify(parsed, null, 2);
		} catch (e) {
			// leave as-is
		}
		await fs.writeFile(file, out, 'utf8');
		return true;
	} catch (e) {
		return false;
	}
}

async function checkExternalForItem(item) {
	// Prefer explicit apiUrl if present (we populate apiUrl to be the provider API),
	// keep `url` as the public summary HTML fallback.
	const apiUrl = item.apiUrl || item.url;
	let htmlUrl = null;
	if (item.type && item.type.startsWith('finra')) {
		// map finra-person -> public summary HTML
		if (item.type === 'finra-person') htmlUrl = `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(item.id)}`;
		if (item.type === 'finra-firm') htmlUrl = `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(item.id)}`;
	}
	if (item.type && item.type.startsWith('sec')) {
		if (item.type === 'sec-person') htmlUrl = `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(item.id)}`;
		if (item.type === 'sec-firm') htmlUrl = `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(item.id)}`;
	}

	// Try API first with retries
	const apiCheck = await retryFetch(apiUrl, MAX_ATTEMPTS);
	const apiRes = apiCheck.result || { ok: false, status: null, error: 'no-response' };

	// If API returned 403 or 401, mark requiresAuth and try html fallback.
	// However, if the API appears transiently down (5xx or network error),
	// do NOT attempt any "healing" checks (HTML fallback) for this item.
	let apiRequiresAuth = false;
	if (apiRes.status === 401 || apiRes.status === 403) apiRequiresAuth = true;

	// detect transient API-down condition (network error or 5xx)
	const apiTransient = !!apiRes && ((apiRes.status && apiRes.status >= 500) || (!apiRes.status && apiRes.error));

	let htmlRes = null;
	let htmlAttempts = 0;
	if (htmlUrl && !apiTransient) {
		const htmlCheck = await retryFetch(htmlUrl, MAX_ATTEMPTS);
		htmlRes = htmlCheck.result || { ok: false, status: null, error: 'no-response' };
		htmlAttempts = htmlCheck.attempts;
	} else if (htmlUrl && apiTransient) {
		// Skipped HTML fallback due to transient API outage
		htmlRes = { ok: false, status: null, error: 'skipped-due-to-api-down' };
		htmlAttempts = 0;
	}

	// interpret results
	const apiOk = !!(apiRes && apiRes.ok && !isBrokercheckError(apiRes.body));
	const htmlOk = !!(htmlRes && htmlRes.ok && !isBrokercheckError(htmlRes.body));

	// If API returned usable data, attempt to cache it in Redis (Upstash) or locally
	// Save both raw body and parsed JSON (when parseable) under separate keys.
	if (apiOk && apiRes && apiRes.body) {
		const cacheKey = `cache:${item.type}::${item.id}`;
		const parsedKey = `cache:parsed:${item.type}::${item.id}`;
		// compress with gzip and convert to base64 for binary storage (smaller payload)
		let rawB64 = null;
		try {
			const gz = zlib.gzipSync(Buffer.from(String(apiRes.body), 'utf8'));
			rawB64 = gz.toString('base64');
		} catch (e) {
			// fallback to plain base64 if compression fails
			rawB64 = Buffer.from(String(apiRes.body), 'utf8').toString('base64');
		}
		let savedRaw = false;
		const meta = { binary: true, encoding: 'base64', compression: 'gzip' };
		if (UPSTASH_URL && UPSTASH_TOKEN) {
			savedRaw = await redisSetKey(cacheKey, rawB64, 2592000, meta);
		}
		if (!savedRaw) {
			await saveLocalApiCache(cacheKey, rawB64, true, meta);
		}

		// attempt to parse JSON and save structured version (text)
		try {
			const parsed = JSON.parse(apiRes.body);
			const parsedString = JSON.stringify(parsed);
			let savedParsed = false;
			if (UPSTASH_URL && UPSTASH_TOKEN) {
				savedParsed = await redisSetKey(parsedKey, parsedString);
			}
			if (!savedParsed) {
				await saveLocalApiCache(parsedKey, parsedString, false);
			}
		} catch (e) {
			// not JSON, skip parsed cache
		}
	}

	// return apiTransient flag for global transient checks
	const apiTransientFlag = !!apiTransient;

	const transient = (apiRes && apiRes.status && apiRes.status >= 500) || (htmlRes && htmlRes.status && htmlRes.status >= 500);

	const reachable = apiOk || htmlOk;

	const noteParts = [];
	if (!apiOk) {
		noteParts.push(`api:${apiRes.status || apiRes.error || 'no'}`);
	}
	if (apiRequiresAuth) noteParts.push('api_requires_auth');
	if (htmlUrl && !htmlOk) noteParts.push(`html:${htmlRes.status || htmlRes.error || 'no'}`);

	return {
		...item,
		api: { ok: apiOk, status: apiRes.status, attempts: apiCheck.attempts },
		html: htmlUrl ? { ok: htmlOk, status: htmlRes && htmlRes.status, attempts: htmlAttempts, url: htmlUrl } : null,
		reachable,
		transient: !!transient,
		apiTransient: apiTransientFlag,
		note: noteParts.join(', '),
	};
}

async function run() {
	const args = process.argv.slice(2);
	const apply = args.includes('--apply');

	let graphRaw;
	try {
		graphRaw = await fs.readFile(GRAPH_PATH, 'utf8');
	} catch (err) {
		console.error('Unable to read graph file:', GRAPH_PATH, err);
		process.exit(2);
	}

	let graph;
	try {
		graph = JSON.parse(graphRaw);
	} catch (err) {
		console.error('Failed to parse graph JSON:', err);
		process.exit(2);
	}

	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const queue = [];

	for (const n of nodes) {
		// determine possible FINRA/SEC CRD ids
		const firmId = n.firmId || (n.id && String(n.id).replace(/^firm[:_]/, ''));
		const individualId = (n.basicInformation && (n.basicInformation.individualId || n.basicInformation.crd)) || n.individualId || (n.id && String(n.id).replace(/^person[:_]/, ''));

		const items = [];
		if (firmId && (n.hasFinraPage || n.bcScope || n.hasFinraData)) {
			items.push({
				type: 'finra-firm',
				id: firmId,
				apiUrl: `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(firmId)}?wt=json`,
				url: `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}`,
			});
		}
		if (individualId && (n.hasFinraPage || n.hasFinraData)) {
			items.push({
				type: 'finra-person',
				id: individualId,
				apiUrl: `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(individualId)}?wt=json`,
				url: `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(individualId)}`,
			});
		}
		if (firmId && (n.hasSecPage || n.hasSecData)) {
			items.push({
				type: 'sec-firm',
				id: firmId,
				apiUrl: `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(firmId)}?wt=json`,
				url: `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}`,
			});
		}
		if (individualId && (n.hasSecPage || n.hasSecData)) {
			items.push({
				type: 'sec-person',
				id: individualId,
				apiUrl: `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(individualId)}?wt=json`,
				url: `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(individualId)}`,
			});
		}

		for (const it of items) {
			queue.push({ nodeId: n.id || null, nodeLabel: n.label || n.name || null, ...it });
		}
	}

	console.log(`Found ${queue.length} external links to validate (from ${nodes.length} nodes)`);

	const results = [];
	// concurrency limiter
	let idx = 0;
	async function worker() {
		while (true) {
			const i = idx++;
			if (i >= queue.length) return;
			const item = queue[i];
			process.stdout.write('.');
			const res = await checkExternalForItem(item);
			results.push(res);
		}
	}

	const workers = [];
	for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
	await Promise.all(workers);
	process.stdout.write('\n');

	const ts = nowIso();

	// Global transient abort: if too many API requests appear transient (network/5xx), abort whole run
	const apiTransientCount = results.filter((r) => r.apiTransient).length;
	const totalApiChecks = results.length || 1;
	const transientPercent = Math.round((apiTransientCount / totalApiChecks) * 100);
	if (transientPercent >= TRANSIENT_ABORT_PERCENT) {
		const abortReportPath = path.join(OUT_DIR, `external_link_validation_${ts}.json`);
		await fs.writeFile(
			abortReportPath,
			JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					applyMode: !!apply,
					aborted: true,
					reason: 'transient-api-failure-rate-exceeded',
					transientPercent,
					apiTransientCount,
					totalChecked: results.length,
				},
				null,
				2,
			),
			'utf8',
		);
		console.warn(`Aborting run: ${transientPercent}% API transient failures (threshold ${TRANSIENT_ABORT_PERCENT}%). Wrote abort report: ${abortReportPath}`);
		process.exit(4);
	}

	// Determine confirmed-unreachable candidates (used for reporting and --apply)
	const confirmed = results.filter((r) => {
		if (r.reachable) return false;
		if (r.transient) return false; // skip transient server errors
		const apiFailed = !(r.api && r.api.ok) && r.api && r.api.attempts >= MAX_ATTEMPTS;
		const htmlFailed = !r.html || (!(r.html && r.html.ok) && r.html && r.html.attempts >= MAX_ATTEMPTS);
		return apiFailed && htmlFailed;
	});

	const reportPath = path.join(OUT_DIR, `external_link_validation_${ts}.json`);
	await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), applyMode: !!apply, results, confirmed }, null, 2), 'utf8');
	console.log('Wrote report:', reportPath);

	if (apply) {
		// --apply mode now writes a suggested changes file only and does NOT modify the graph
		// If Upstash is configured, use it to maintain consecutive-failure counts
		async function redisIncr(key) {
			if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
			try {
				const res = await fetch(`${UPSTASH_URL}/incr/${encodeURIComponent(key)}`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
				});
				const j = await res.json();
				return j.result;
			} catch (e) {
				return null;
			}
		}
		async function redisDel(key) {
			if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
			try {
				const res = await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
				});
				const j = await res.json();
				return j.result;
			} catch (e) {
				return null;
			}
		}

		const suggested = [];
		for (const r of confirmed) {
			const key = `${KEY_PREFIX}${r.type}::${r.id}`;
			let count = null;
			if (UPSTASH_URL && UPSTASH_TOKEN) {
				count = await redisIncr(key);
				// set expire to 30 days
				try {
					await fetch(`${UPSTASH_URL}/expire/${encodeURIComponent(key)}/2592000`, {
						method: 'POST',
						headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
					});
				} catch (e) {}
			} else {
				// fallback: store local file counts under OUT_DIR/_validate_counts.json
				const countsFile = path.join(OUT_DIR, '_validate_counts.json');
				let counts = {};
				try {
					const txt = await fs.readFile(countsFile, 'utf8');
					counts = JSON.parse(txt);
				} catch (e) {}
				counts[key] = (counts[key] || 0) + 1;
				await fs.writeFile(countsFile, JSON.stringify(counts, null, 2), 'utf8');
				count = counts[key];
			}

			// if count reaches threshold, add to suggested list
			if (count !== null && count >= CONFIRM_THRESHOLD) {
				suggested.push({ type: r.type, id: r.id, nodeId: r.nodeId, note: r.note, api: r.api, html: r.html, consecutiveFailures: count });
			}
		}

		// For items that were previously failing but now reachable, clear their counters
		const nowReachable = results.filter((r) => r.reachable && r.nodeId);
		for (const r of nowReachable) {
			const key = `${KEY_PREFIX}${r.type}::${r.id}`;
			if (UPSTASH_URL && UPSTASH_TOKEN) {
				try {
					await redisDel(key);
				} catch (e) {}
			} else {
				const countsFile = path.join(OUT_DIR, '_validate_counts.json');
				try {
					const txt = await fs.readFile(countsFile, 'utf8');
					const counts = JSON.parse(txt);
					if (counts[key]) {
						delete counts[key];
						await fs.writeFile(countsFile, JSON.stringify(counts, null, 2), 'utf8');
					}
				} catch (e) {}
			}
		}

		const suggestedPath = path.join(OUT_DIR, `external_link_suggested_changes_${ts}.json`);
		await fs.writeFile(suggestedPath, JSON.stringify({ generatedAt: new Date().toISOString(), suggested, threshold: CONFIRM_THRESHOLD }, null, 2), 'utf8');
		console.log('Wrote suggested changes (no modifications performed):', suggestedPath);
		console.log('Note: this script will NOT retire or remove APIs. Use the suggestions to review and apply changes manually if desired.');
	}

	// Report summary: count confirmed unreachable (not transient) vs total checked
	const totalChecked = results.length;
	const confirmedUnreachableCount = confirmed.length;
	if (confirmedUnreachableCount > 0) {
		console.warn(`Found ${confirmedUnreachableCount} confirmed-unreachable external links (after retries). See report: ${reportPath}`);
		process.exit(3);
	}

	console.log('All checked links appear reachable.');
	process.exit(0);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
