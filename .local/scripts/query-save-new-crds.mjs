#!/usr/bin/env node
/**
 * Query FINRA/SEC search for terms, then by-id detail + source-coverage gate
 * before writing local Redis AND data/raw/ (disk backup). Stops after N newly
 * saved CRDs.
 *
 *   npx tsx --env-file=.env.local .local/scripts/query-save-new-crds.mjs --target=10
 *   npx tsx --env-file=.env.local .local/scripts/query-save-new-crds.mjs --terms-file=.local/tmp/terms.txt --target=0
 *   npx tsx --env-file=.env.local .local/scripts/query-save-new-crds.mjs --backfill-raw=6849383,340663
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import IORedis from 'ioredis';
import {
	hasFirmSourceCoverage,
	hasIndividualSourceCoverage,
} from '../../src/lib/sourceTruth.ts';

const TARGET_RAW = (process.argv.find((a) => a.startsWith('--target=')) || '--target=10').slice('--target='.length);
const TARGET = TARGET_RAW === '0' || TARGET_RAW === 'unlimited' ? Number.POSITIVE_INFINITY : Number(TARGET_RAW);
const BACKFILL_RAW = (process.argv.find((a) => a.startsWith('--backfill-raw=')) || '')
	.slice('--backfill-raw='.length)
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const SKIP_TERMS = new Set(
	(process.argv.find((a) => a.startsWith('--skip-terms=')) || '')
		.slice('--skip-terms='.length)
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean),
);
const TERMS_FILE = (process.argv.find((a) => a.startsWith('--terms-file=')) || '').slice('--terms-file='.length);
const TERMS_CSV = (process.argv.find((a) => a.startsWith('--terms=')) || '').slice('--terms='.length);
const SLEEP_MS = 250;
const ROOT = process.cwd();

const DEFAULT_TERMS = [
	'eye', 'elit', 'maso', 'indo', 'nord', 'pope', 'holy', 'vati', 'arch', 'pray', 'rite', 'cult',
	'glor', 'lord', 'deit', 'divi', 'omni', 'fien', 'evil', 'asmo', 'succ', 'ufo', 'grey', 'abdu',
	'tart', 'mudf', 'rese', 'dome', 'free', 'star', 'obel', 'prov', 'pyra', 'ankh', 'alle', 'esot',
	'cons', 'scar', 'papa', 'herm', 'basi', 'phar', 'secr', 'shro', 'hier', 'sphin', 'occu', 'pete',
	'gene', 'supe', 'epic', 'funn', 'nosf', 'cove', 'enta', 'magn', 'updr', 'bloo', 'hex', 'exod',
	'quan', 'faul', 'vort', 'immo', 'spel', 'prop', 'wave', 'seis', 'meso', 'stak', 'fami', 'apoc',
	'qubi', 'tect', 'fuji', 'garl', 'broo', 'apos', 'prob', 'afte', 'dopp', 'fang', 'tali', 'para',
	'deco', 'mult', 'tran', 'caul', 'unce', 'liq', 'squa', 'bat', 'invo',
];

function loadTerms() {
	let raw = [];
	if (TERMS_FILE) {
		const text = fsSync.readFileSync(path.resolve(ROOT, TERMS_FILE), 'utf8');
		raw = text.split(/[\n,]+/);
	} else if (TERMS_CSV) {
		raw = TERMS_CSV.split(/[\n,]+/);
	} else {
		raw = DEFAULT_TERMS;
	}
	const seen = new Set();
	const out = [];
	for (const t of raw) {
		const term = String(t || '').trim();
		if (!term) continue;
		const key = term.toLowerCase();
		if (SKIP_TERMS.has(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(term);
	}
	return out;
}

const TERMS = loadTerms();

const redis = new IORedis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function compressPayload(value) {
	const s = typeof value === 'string' ? value : JSON.stringify(value);
	if (s.length > 512) {
		try {
			return 'br:' + zlib.brotliCompressSync(Buffer.from(s)).toString('base64');
		} catch {
			return s;
		}
	}
	return s;
}

function decompressPayload(value) {
	if (typeof value === 'string' && value.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(value.slice(3), 'base64')).toString('utf8');
		} catch {
			return value;
		}
	}
	return value;
}

/** Mirror existing on-disk naming under data/raw/{host}/api.{host}_search_{kind}_{crd}.json */
function rawDetailPath(host, kind, crd) {
	const dir =
		host === 'finra'
			? path.join(ROOT, 'data/raw/brokercheck.finra.org')
			: path.join(ROOT, 'data/raw/adviserinfo.sec.gov');
	const file =
		host === 'finra'
			? `api.brokercheck.finra.org_search_${kind}_${crd}.json`
			: `api.adviserinfo.sec.gov_search_${kind}_${crd}.json`;
	return path.join(dir, file);
}

async function writeRawDetail(host, kind, crd, envelope) {
	const filePath = rawDetailPath(host, kind, crd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf8');
	return filePath;
}

async function fetchJson(url) {
	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
			'User-Agent': 'finra-local-query-save/1.0',
		},
		redirect: 'follow',
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.json();
}

function extractHits(payload) {
	const hits = payload?.hits?.hits;
	return Array.isArray(hits) ? hits : [];
}

function parseEmbedded(source, keys) {
	if (!source || typeof source !== 'object') return null;
	for (const key of keys) {
		const raw = source[key];
		if (raw == null) continue;
		if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === 'object') return parsed;
			} catch {
				return null;
			}
		}
	}
	return null;
}

function firmIdFromHit(source) {
	return String(source?.firm_source_id || source?.firm_id || source?.firmId || '').trim();
}

function firmNameFromHit(source) {
	return String(source?.firm_name || source?.firmName || '').trim();
}

function indIdFromHit(source) {
	return String(source?.ind_source_id || source?.ind_crd || source?.individualId || source?.crd || '').trim();
}

function indNameFromHit(source) {
	const parts = [source?.ind_firstname, source?.ind_middlename, source?.ind_lastname]
		.map((x) => String(x || '').trim())
		.filter(Boolean);
	return parts.join(' ') || String(source?.ind_name || source?.name || '').trim();
}

async function alreadyHave(kind, crd) {
	const keys =
		kind === 'firm'
			? [`finra:firm:${crd}`, `sec:firm:${crd}`]
			: [`finra:individual:${crd}`, `sec:individual:${crd}`];
	const counts = await Promise.all(keys.map((k) => redis.exists(k)));
	return counts.some((n) => Number(n) > 0);
}

async function queryTerm(term) {
	const urls = [
		{ kind: 'firm', host: 'finra', url: `https://api.brokercheck.finra.org/search/firm?query=${encodeURIComponent(term)}&hl=true&nrows=12&start=0&wt=json` },
		{ kind: 'firm', host: 'sec', url: `https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(term)}&hl=true&nrows=12&start=0&wt=json` },
		{ kind: 'individual', host: 'finra', url: `https://api.brokercheck.finra.org/search/individual?query=${encodeURIComponent(term)}&hl=true&nrows=12&start=0&wt=json` },
		{ kind: 'individual', host: 'sec', url: `https://api.adviserinfo.sec.gov/search/individual?query=${encodeURIComponent(term)}&hl=true&nrows=12&start=0&wt=json` },
	];
	const out = [];
	for (const u of urls) {
		try {
			const data = await fetchJson(u.url);
			for (const hit of extractHits(data)) {
				const source = hit?._source || {};
				if (u.kind === 'firm') {
					const id = firmIdFromHit(source);
					if (/^\d{1,10}$/.test(id)) out.push({ kind: 'firm', crd: id, name: firmNameFromHit(source), term, fromHost: u.host });
				} else {
					const id = indIdFromHit(source);
					if (/^\d{1,10}$/.test(id)) out.push({ kind: 'individual', crd: id, name: indNameFromHit(source), term, fromHost: u.host });
				}
			}
		} catch (e) {
			console.warn(`query fail term=${term} ${u.host}/${u.kind}: ${e.message}`);
		}
		await sleep(SLEEP_MS);
	}
	return out;
}

function detailUrls(kind, crd) {
	if (kind === 'firm') {
		return {
			finra: `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(crd)}?hl=true&wt=json`,
			sec: `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(crd)}?hl=true&wt=json`,
		};
	}
	return {
		finra: `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&wt=json`,
		sec: `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&wt=json`,
	};
}

function detailFromEnvelope(kind, host, envelope) {
	const hit = extractHits(envelope)[0];
	if (!hit) return null;
	const source = hit._source || {};
	if (host === 'finra') return parseEmbedded(source, ['content', 'iacontent']);
	return parseEmbedded(source, ['iacontent', 'content']);
}

function summarizeDetail(kind, detail) {
	if (!detail || typeof detail !== 'object') return {};
	const basic = detail.basicInformation || {};
	if (kind === 'firm') {
		return {
			name: basic.firmName || detail.firmName || '',
			bcScope: detail.bcScope ?? basic.bcScope ?? null,
			iaScope: detail.iaScope ?? basic.iaScope ?? null,
			isIAFirm: detail.isIAFirm ?? basic.isIAFirm ?? null,
		};
	}
	const name =
		[basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ') ||
		basic.name ||
		'';
	return {
		name,
		bcScope: detail.bcScope ?? basic.bcScope ?? null,
		iaScope: detail.iaScope ?? basic.iaScope ?? null,
	};
}

async function saveNewCrd(kind, crd, meta = {}) {
	if (await alreadyHave(kind, crd)) {
		return { status: 'exists', kind, crd };
	}

	const urls = detailUrls(kind, crd);
	const written = [];
	const skipped = [];
	const details = {};

	for (const host of ['finra', 'sec']) {
		let envelope;
		try {
			envelope = await fetchJson(urls[host]);
		} catch (e) {
			skipped.push({ host, reason: `fetch: ${e.message}` });
			await sleep(SLEEP_MS);
			continue;
		}
		await sleep(SLEEP_MS);

		const total = envelope?.hits?.total;
		const totalVal = typeof total === 'number' ? total : total?.value;
		if (!totalVal || !extractHits(envelope).length) {
			skipped.push({ host, reason: 'empty hits' });
			continue;
		}

		const detail = detailFromEnvelope(kind, host, envelope);
		if (!detail) {
			skipped.push({ host, reason: 'no embedded content/iacontent' });
			continue;
		}

		const covered =
			kind === 'firm' ? hasFirmSourceCoverage(detail, host) : hasIndividualSourceCoverage(detail, host);
		const summary = summarizeDetail(kind, detail);
		details[host] = { covered, ...summary };

		if (!covered) {
			skipped.push({ host, reason: 'no source coverage', ...summary });
			continue;
		}

		const key = `${host}:${kind}:${crd}`;
		await redis.set(key, compressPayload(JSON.stringify(envelope)));
		const rawPath = await writeRawDetail(host, kind, crd, envelope);
		written.push({ key, rawPath, ...summary });
	}

	if (!written.length) {
		return { status: 'no-coverage', kind, crd, meta, details, skipped };
	}

	return {
		status: 'saved',
		kind,
		crd,
		meta,
		written,
		skipped,
		details,
	};
}

async function backfillRawFromRedis(crds) {
	const results = [];
	for (const crd of crds) {
		for (const kind of ['individual', 'firm']) {
			for (const host of ['finra', 'sec']) {
				const key = `${host}:${kind}:${crd}`;
				const raw = await redis.get(key);
				if (!raw) continue;
				try {
					const envelope = JSON.parse(decompressPayload(raw));
					const rawPath = await writeRawDetail(host, kind, crd, envelope);
					results.push({ key, rawPath });
					console.log(JSON.stringify({ phase: 'backfill-raw', key, rawPath }));
				} catch (e) {
					console.warn(JSON.stringify({ phase: 'backfill-raw-fail', key, error: e.message }));
				}
			}
		}
	}
	return results;
}

async function main() {
	if (BACKFILL_RAW.length) {
		const results = await backfillRawFromRedis(BACKFILL_RAW);
		console.log(JSON.stringify({ ok: true, phase: 'backfill-done', count: results.length, results }, null, 2));
		await redis.quit();
		return;
	}

	const seen = new Set();
	const saved = [];
	const rejected = [];
	let queries = 0;

	console.log(
		JSON.stringify({
			phase: 'start',
			target: Number.isFinite(TARGET) ? TARGET : 'unlimited',
			terms: TERMS.length,
			skippedTerms: [...SKIP_TERMS],
			writeRaw: true,
		}),
	);

	for (const term of TERMS) {
		if (saved.length >= TARGET) break;
		console.log(JSON.stringify({ phase: 'query', term, savedSoFar: saved.length }));
		const hits = await queryTerm(term);
		queries += 1;

		// Prefer higher CRDs first within this term
		hits.sort((a, b) => Number(b.crd) - Number(a.crd));

		for (const hit of hits) {
			if (saved.length >= TARGET) break;
			const idKey = `${hit.kind}:${hit.crd}`;
			if (seen.has(idKey)) continue;
			seen.add(idKey);

			if (await alreadyHave(hit.kind, hit.crd)) continue;

			const result = await saveNewCrd(hit.kind, hit.crd, {
				term: hit.term,
				queryName: hit.name,
				fromHost: hit.fromHost,
			});

			if (result.status === 'saved') {
				saved.push(result);
				console.log(
					JSON.stringify({
						phase: 'saved',
						n: saved.length,
						kind: result.kind,
						crd: result.crd,
						keys: result.written.map((w) => w.key),
						name: result.written[0]?.name || hit.name,
					}),
				);
			} else if (result.status === 'no-coverage') {
				rejected.push(result);
				console.log(JSON.stringify({ phase: 'skip-no-coverage', kind: hit.kind, crd: hit.crd, name: hit.name }));
			}
		}
	}

	const report = {
		ok: true,
		target: Number.isFinite(TARGET) ? TARGET : 'unlimited',
		savedCount: saved.length,
		queries,
		candidatesConsidered: seen.size,
		rejectedNoCoverage: rejected.length,
		saved: saved.map((s) => ({
			kind: s.kind,
			crd: s.crd,
			keys: s.written.map((w) => w.key),
			rawPaths: s.written.map((w) => w.rawPath),
			name: s.written[0]?.name || s.meta?.queryName,
			term: s.meta?.term,
		})),
		rejectedSample: rejected.slice(0, 20).map((r) => ({ kind: r.kind, crd: r.crd, name: r.meta?.queryName })),
	};
	console.log('=== REPORT ===');
	console.log(JSON.stringify(report, null, 2));
	await redis.quit();
	process.exit(0);
}

main().catch(async (e) => {
	console.error(e);
	try {
		await redis.quit();
	} catch {}
	process.exit(1);
});
