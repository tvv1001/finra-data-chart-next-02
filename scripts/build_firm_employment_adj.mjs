/**
 * Build firm → employee reverse adjacency from primed:bundle:finra-individual*
 * and write per-firm Redis keys for O(1) firm /connections lookups.
 *
 * Usage:
 *   node scripts/build_firm_employment_adj.js
 *   node scripts/build_firm_employment_adj.js --dry-run
 *   node scripts/build_firm_employment_adj.js --firm 107342
 *
 * Keys written:
 *   graph:firm-emp-adj:v1:{firmId}  → JSON { current: [...], previous: [...] }
 *   graph:firm-emp-adj:v1:meta      → { builtAt, firmCount, edgeCount, version }
 *
 * Production policy: run from branch/deploy workflow against the intended Redis.
 * Do not treat this as an ad-hoc prod mutation unless the user explicitly asks.
 */
import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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
	} catch {
		/* ignore */
	}
}

loadEnv(path.join(root, '.env.local'));
loadEnv(path.join(root, '.env'));

const VERSION = 'v1';
const KEY_PREFIX = `graph:firm-emp-adj:${VERSION}`;
const META_KEY = `${KEY_PREFIX}:meta`;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const firmFilterIdx = args.indexOf('--firm');
const firmFilter = firmFilterIdx >= 0 ? String(args[firmFilterIdx + 1] || '').trim() : '';

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

function decodeBundlePayload(raw) {
	if (!raw) return null;
	if (raw.startsWith('br:')) return JSON.parse(decompressPayload(raw));
	return JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
}

function toArraySafe(value) {
	return Array.isArray(value) ? value : [];
}

function firstNonEmpty(...values) {
	for (const value of values) {
		const text = String(value ?? '').trim();
		if (text) return text;
	}
	return '';
}

function unwrapIndividualRecord(raw) {
	let data = raw;
	if (typeof data === 'string') {
		try {
			const text = data.startsWith('br:') ? decompressPayload(data) : data;
			data = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (!data || typeof data !== 'object') return null;
	const src = data?.hits?.hits?.length ? data.hits.hits[0]?._source : data;
	if (!src) return null;
	let parsed = {};
	const content = src.content ?? src.iacontent;
	if (typeof content === 'string') {
		try {
			parsed = JSON.parse(content);
		} catch {
			parsed = {};
		}
	} else if (content && typeof content === 'object') {
		parsed = content;
	}
	return { ...src, ...parsed };
}

async function loadPrimedIndividualBundle(redis) {
	const single = await redis.get('primed:bundle:finra-individual');
	if (typeof single === 'string' && single) {
		const decoded = decodeBundlePayload(single);
		if (decoded) return decoded;
	}
	const rawMeta = await redis.get('primed:bundle:finra-individual:meta');
	if (!rawMeta) throw new Error('Missing primed:bundle:finra-individual:meta');
	const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
	const chunkCount = Number(meta?.chunks || meta?.parts || 0);
	if (!Number.isFinite(chunkCount) || chunkCount <= 0) throw new Error('Invalid primed chunk count');
	const parts = await Promise.all(Array.from({ length: chunkCount }, (_, i) => redis.get(`primed:bundle:finra-individual:part:${i}`)));
	if (parts.some((p) => p == null)) throw new Error('Missing primed bundle part');
	return decodeBundlePayload(parts.join(''));
}

function buildIndex(bundle) {
	/** @type {Map<string, { current: any[], previous: any[] }>} */
	const index = new Map();

	for (const [key, value] of Object.entries(bundle)) {
		const payload = unwrapIndividualRecord(value);
		if (!payload) continue;
		const personCrd = firstNonEmpty(
			payload?.basicInformation?.individualId,
			payload?.basicInformation?.ind_source_id,
			payload?.ind_source_id,
			payload?.ind_crd,
			payload?.crd,
			key.match(/individual:(\d{1,10})/i)?.[1],
		);
		if (!personCrd) continue;
		const bi = payload?.basicInformation || {};
		const personName = firstNonEmpty(
			[bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' '),
			[payload?.ind_firstname, payload?.ind_middlename, payload?.ind_lastname].filter(Boolean).join(' '),
			payload?.individualName,
			payload?.name,
		);

		const currentEmployments = [
			...toArraySafe(payload.currentEmployments),
			...toArraySafe(payload.currentIAEmployments),
			...toArraySafe(payload.ind_current_employments),
			...toArraySafe(payload.ind_ia_current_employments),
		];
		const previousEmployments = [
			...toArraySafe(payload.previousEmployments),
			...toArraySafe(payload.previousIAEmployments),
			...toArraySafe(payload.ind_previous_employments),
			...toArraySafe(payload.ind_ia_previous_employments),
		];

		const add = (entry, isCurrent) => {
			const firmId = firstNonEmpty(entry?.firmId, entry?.firm_id);
			if (!firmId) return;
			if (firmFilter && firmId !== firmFilter) return;
			const bucket = index.get(firmId) || { current: [], previous: [] };
			const edge = {
				individualId: personCrd,
				name: personName,
				relationship: isCurrent ? 'Current registration' : 'Previous registration',
				startDate: firstNonEmpty(entry?.registrationBeginDate, entry?.startDate) || undefined,
				endDate: isCurrent ? undefined : firstNonEmpty(entry?.registrationEndDate, entry?.endDate) || undefined,
				isCurrent,
				bcScope: firstNonEmpty(payload?.bcScope, bi.bcScope) || undefined,
				iaScope: firstNonEmpty(payload?.iaScope, bi.iaScope) || undefined,
			};
			(isCurrent ? bucket.current : bucket.previous).push(edge);
			index.set(firmId, bucket);
		};

		for (const entry of currentEmployments) add(entry, true);
		for (const entry of previousEmployments) add(entry, false);
	}

	// Deduplicate
	for (const [firmId, bucket] of index) {
		const dedupe = (list) => {
			const seen = new Set();
			const out = [];
			for (const edge of list) {
				const k = `${edge.individualId}:${edge.isCurrent}`;
				if (seen.has(k)) continue;
				seen.add(k);
				out.push(edge);
			}
			return out;
		};
		index.set(firmId, { current: dedupe(bucket.current), previous: dedupe(bucket.previous) });
	}

	return index;
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');

	const redis = new Redis({ url, token });
	console.log('Loading primed finra-individual bundle…');
	const t0 = Date.now();
	const bundle = await loadPrimedIndividualBundle(redis);
	console.log(`Bundle loaded in ${Date.now() - t0}ms, keys=${Object.keys(bundle).length}`);

	const index = buildIndex(bundle);
	let edgeCount = 0;
	for (const bucket of index.values()) edgeCount += bucket.current.length + bucket.previous.length;
	console.log(`Index firms=${index.size} edges=${edgeCount}${firmFilter ? ` filter=${firmFilter}` : ''}`);

	if (firmFilter) {
		const sample = index.get(firmFilter);
		console.log(
			'sample firm',
			firmFilter,
			sample ? { current: sample.current.length, previous: sample.previous.length, people: [...sample.current, ...sample.previous].slice(0, 5) } : null,
		);
	}

	if (dryRun) {
		console.log('Dry run — no Redis writes');
		return;
	}

	const entries = Array.from(index.entries());
	const BATCH = 50;
	let written = 0;
	for (let i = 0; i < entries.length; i += BATCH) {
		const slice = entries.slice(i, i + BATCH);
		await Promise.all(
			slice.map(([firmId, bucket]) =>
				redis.set(
					`${KEY_PREFIX}:${firmId}`,
					{
						currentConnections: bucket.current,
						previousConnections: bucket.previous,
					},
					{ ex: TTL_SECONDS },
				),
			),
		);
		written += slice.length;
		if (written % 500 === 0 || written === entries.length) {
			console.log(`Wrote ${written}/${entries.length}`);
		}
	}

	await redis.set(
		META_KEY,
		{
			version: VERSION,
			builtAt: new Date().toISOString(),
			firmCount: index.size,
			edgeCount,
			firmFilter: firmFilter || null,
		},
		{ ex: TTL_SECONDS },
	);

	console.log(`Done. meta=${META_KEY}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
