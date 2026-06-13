import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Redis } from '@upstash/redis';
import { setStringIfValid } from '@/lib/redisCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';
const DEFAULT_EXTERNAL_RAW_DIR = '/home/lenny/Dev/webDev/Data-finra-sec/data/raw';
const PRIMED_REDIS_CHUNK_CHARS = Number(process.env.PRIMED_REDIS_CHUNK_CHARS || 700_000);

type DashboardAction = 'fetch-crds' | 'sync-and-deploy-primed';

type RefreshRequestBody = {
	action?: DashboardAction;
	crds?: string[] | string;
	queries?: string[] | string;
	externalRawDir?: string;
	maxCrds?: number;
};

type FetchResultItem = {
	crd: string;
	source: 'finra' | 'sec';
	type: 'individual' | 'firm';
	url: string;
	cacheFile: string;
	redisKey: string;
	status: 'ok' | 'error';
	redisWrite: string;
	error?: string;
};

type FetchTarget = {
	crd: string;
	source: 'finra' | 'sec';
	type: 'individual' | 'firm';
};

function isObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidFetchedPayload(payload: unknown): boolean {
	if (!isObject(payload)) return false;

	const hasHitArray = Array.isArray(payload?.hits?.hits);
	const hasDocsArray = Array.isArray(payload?.response?.docs) || Array.isArray(payload?.results) || Array.isArray(payload?.currentPage);
	const hasDetailMarkers =
		payload?.content != null ||
		payload?.iacontent != null ||
		payload?.basicInformation != null ||
		payload?.individualId != null ||
		payload?.firmId != null ||
		payload?.name != null ||
		payload?.firmName != null;
	const hasErrorOnly = typeof payload?.error === 'string' && !hasHitArray && !hasDocsArray && !hasDetailMarkers;

	if (hasErrorOnly) return false;
	return hasHitArray || hasDocsArray || hasDetailMarkers;
}

function parseCrds(input: RefreshRequestBody['crds'], maxCrds = 50): string[] {
	const tokens =
		typeof input === 'string' ?
			input
				.split(/[\s,]+/g)
				.map((value) => value.trim())
				.filter(Boolean)
		: Array.isArray(input) ? input.map((value) => String(value || '').trim()).filter(Boolean)
		: [];

	const unique = Array.from(new Set(tokens.filter((value) => /^\d{1,10}$/.test(value))));
	return unique.slice(0, Math.max(1, Math.min(500, maxCrds)));
}

function parseQueries(input: RefreshRequestBody['queries'] | RefreshRequestBody['crds'], maxQueries = 50): string[] {
	const tokens =
		typeof input === 'string' ?
			input
				.split(/[\n,;]+/g)
				.map((value) => value.trim())
				.filter(Boolean)
		: Array.isArray(input) ? input.map((value) => String(value || '').trim()).filter(Boolean)
		: [];

	const unique = Array.from(new Set(tokens));
	return unique.slice(0, Math.max(1, Math.min(200, maxQueries)));
}

function collectSearchItems(payload: any) {
	if (Array.isArray(payload?.results)) return payload.results;
	if (Array.isArray(payload?.currentPage)) return payload.currentPage;
	if (Array.isArray(payload?.hits?.hits)) return payload.hits.hits.map((hit: any) => hit?._source ?? hit);
	return [];
}

function extractNumericId(item: any, keys: string[]) {
	for (const key of keys) {
		const raw = item?.[key];
		if (raw == null) continue;
		const value = String(raw).trim();
		if (/^\d{1,10}$/.test(value)) return value;
	}
	return '';
}

async function resolveCrdsFromQueries(queries: string[], maxCrds = 50) {
	const resolved = new Set<string>();
	const targetMap = new Map<string, FetchTarget>();
	const resolution: Array<{ query: string; crdCount: number; crds: string[] }> = [];

	const addTarget = (target: FetchTarget) => {
		targetMap.set(`${target.source}:${target.type}:${target.crd}`, target);
	};

	const canIncludeCrd = (crd: string) => {
		if (resolved.has(crd)) return true;
		if (resolved.size >= maxCrds) return false;
		resolved.add(crd);
		return true;
	};

	for (const query of queries) {
		if (resolved.size >= maxCrds) break;
		if (/^\d{1,10}$/.test(query)) {
			if (canIncludeCrd(query)) {
				addTarget({ crd: query, source: 'finra', type: 'individual' });
				addTarget({ crd: query, source: 'sec', type: 'individual' });
				addTarget({ crd: query, source: 'finra', type: 'firm' });
				addTarget({ crd: query, source: 'sec', type: 'firm' });
			}
			resolution.push({ query, crdCount: 1, crds: [query] });
			continue;
		}

		try {
			const encoded = encodeURIComponent(query);
			const [finraIndividual, finraFirm, secIndividual, secFirm] = await Promise.all([
				fetchJson(`https://api.brokercheck.finra.org/search/individual?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
				fetchJson(`https://api.brokercheck.finra.org/search/firm?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
				fetchJson(`https://api.adviserinfo.sec.gov/search/individual?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
				fetchJson(`https://api.adviserinfo.sec.gov/search/firm?query=${encoded}&hl=true&wt=json&nrows=12&start=0`),
			]);

			const crdsForQuery = new Set<string>();
			const individualKeys = ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id'];
			const firmKeys = ['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];

			for (const item of collectSearchItems(finraIndividual)) {
				const id = extractNumericId(item, individualKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'finra', type: 'individual' });
			}
			for (const item of collectSearchItems(finraFirm)) {
				const id = extractNumericId(item, firmKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'finra', type: 'firm' });
			}
			for (const item of collectSearchItems(secIndividual)) {
				const id = extractNumericId(item, individualKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'sec', type: 'individual' });
			}
			for (const item of collectSearchItems(secFirm)) {
				const id = extractNumericId(item, firmKeys);
				if (!id || !canIncludeCrd(id)) continue;
				crdsForQuery.add(id);
				addTarget({ crd: id, source: 'sec', type: 'firm' });
			}

			const crds = Array.from(crdsForQuery);
			resolution.push({ query, crdCount: crds.length, crds: crds.slice(0, 25) });
		} catch {
			resolution.push({ query, crdCount: 0, crds: [] });
		}
	}

	return {
		crds: Array.from(resolved).slice(0, maxCrds),
		targets: Array.from(targetMap.values()),
		resolution,
	};
}

function ensureRedisClient() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	return new Redis({ url, token });
}

async function exists(targetPath: string) {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function writeJsonFile(filePath: string, payload: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function fetchJson(url: string) {
	const response = await fetch(url, {
		headers: {
			'Accept': 'application/json',
			'User-Agent': 'finra-dashboard-refresh/1.0',
		},
		next: { revalidate: 0 },
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return response.json();
}

function splitIntoChunks(value: string, maxChunkChars: number) {
	const chunks: string[] = [];
	for (let index = 0; index < value.length; index += maxChunkChars) {
		chunks.push(value.slice(index, index + maxChunkChars));
	}
	return chunks;
}

function bundleKey(bundleName: string) {
	return `primed:bundle:${bundleName}`;
}

function bundleMetaKey(bundleName: string) {
	return `${bundleKey(bundleName)}:meta`;
}

function bundlePartKey(bundleName: string, index: number) {
	return `${bundleKey(bundleName)}:part:${index}`;
}

async function uploadBundle(redis: Redis, bundleName: string, payloadBase64: string) {
	const key = bundleKey(bundleName);
	const metaKey = bundleMetaKey(bundleName);
	const chunks = splitIntoChunks(payloadBase64, PRIMED_REDIS_CHUNK_CHARS);

	if (chunks.length <= 1) {
		await redis.set(key, payloadBase64);
		await redis.del(metaKey).catch(() => 0);
		return { bundleName, mode: 'single', chunks: 1 };
	}

	await redis.del(key).catch(() => 0);
	for (let index = 0; index < chunks.length; index += 1) {
		await redis.set(bundlePartKey(bundleName, index), chunks[index]);
	}
	await redis.set(
		metaKey,
		JSON.stringify({
			encoding: 'base64-gzip',
			chunked: true,
			chunks: chunks.length,
			chunkChars: PRIMED_REDIS_CHUNK_CHARS,
			updatedAt: new Date().toISOString(),
		}),
	);

	return { bundleName, mode: 'chunked', chunks: chunks.length };
}

async function syncExternalRawToLocal(externalRawDir: string) {
	const localRawDir = path.join(process.cwd(), 'data', 'raw');
	const stats = { copied: 0, skipped: 0, missingSource: false, source: externalRawDir, target: localRawDir };

	if (!(await exists(externalRawDir))) {
		stats.missingSource = true;
		return stats;
	}

	async function syncDir(sourceDir: string, targetDir: string): Promise<void> {
		await fs.mkdir(targetDir, { recursive: true });
		const entries = await fs.readdir(sourceDir, { withFileTypes: true });

		for (const entry of entries) {
			const sourcePath = path.join(sourceDir, entry.name);
			const targetPath = path.join(targetDir, entry.name);

			if (entry.isDirectory()) {
				await syncDir(sourcePath, targetPath);
				continue;
			}

			if (!entry.isFile()) continue;

			let shouldCopy = true;
			if (await exists(targetPath)) {
				const [sourceStat, targetStat] = await Promise.all([fs.stat(sourcePath), fs.stat(targetPath)]);
				shouldCopy = sourceStat.size !== targetStat.size || sourceStat.mtimeMs > targetStat.mtimeMs;
			}

			if (!shouldCopy) {
				stats.skipped += 1;
				continue;
			}

			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.copyFile(sourcePath, targetPath);
			stats.copied += 1;
		}
	}

	await syncDir(externalRawDir, localRawDir);
	return stats;
}

async function fetchCrdsToCacheAndRedis(targets: FetchTarget[]) {
	const results: FetchResultItem[] = [];
	const nationalRoot = path.join(process.cwd(), 'data', 'national');
	const rawRoot = path.join(process.cwd(), 'data', 'raw');

	for (const target of targets) {
		const crd = target.crd;
		const isFinra = target.source === 'finra';
		const isIndividual = target.type === 'individual';
		const url =
			isFinra && isIndividual ? `https://api.brokercheck.finra.org/search/individual/${crd}?hl=true&wt=json`
			: isFinra && !isIndividual ? `https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&wt=json`
			: !isFinra && isIndividual ? `https://api.adviserinfo.sec.gov/search/individual/${crd}?wt=json`
			: `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`;
		const cacheFileName = `api.${isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov'}_search_${target.type}_${crd}.json`;
		const cacheDir = isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
		const redisKey = target.type === 'individual' ? `${target.source}:individual:${crd}:${DEFAULT_INDIVIDUAL_QUERY}` : `${target.source}:firm:${crd}:${DEFAULT_FIRM_QUERY}`;

		try {
			const payload = await fetchJson(url);
			if (!isValidFetchedPayload(payload)) {
				results.push({
					crd,
					source: target.source,
					type: target.type,
					url,
					cacheFile: path.join(nationalRoot, cacheDir, cacheFileName),
					redisKey,
					status: 'error',
					redisWrite: 'not-attempted',
					error: 'invalid-payload-shape',
				});
				continue;
			}

			const nationalFile = path.join(nationalRoot, cacheDir, cacheFileName);
			const rawFile = path.join(rawRoot, cacheDir, cacheFileName);
			await Promise.all([writeJsonFile(nationalFile, payload), writeJsonFile(rawFile, payload)]);

			const redisWrite = await setStringIfValid(redisKey, JSON.stringify(payload), 60 * 60 * 24);

			results.push({
				crd,
				source: target.source,
				type: target.type,
				url,
				cacheFile: nationalFile,
				redisKey,
				status: 'ok',
				redisWrite,
			});
		} catch (error: any) {
			results.push({
				crd,
				source: target.source,
				type: target.type,
				url,
				cacheFile: path.join(nationalRoot, cacheDir, cacheFileName),
				redisKey,
				status: 'error',
				redisWrite: 'not-attempted',
				error: error?.message || String(error),
			});
		}
	}

	const successCount = results.filter((item) => item.status === 'ok').length;
	const errorCount = results.length - successCount;
	const uniqueCrds = new Set(results.map((item) => item.crd));

	return {
		summary: {
			crdCount: uniqueCrds.size,
			requests: results.length,
			successCount,
			errorCount,
		},
		results,
	};
}

async function deployPrimedBundlesToRedis() {
	const redis = ensureRedisClient();
	if (!redis) {
		throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for deployment.');
	}

	const primedDir = path.join(process.cwd(), 'data', 'national', 'primed-cache');
	const files = await fs.readdir(primedDir).catch(() => []);
	const bundleNames = files
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.replace(/\.json$/i, ''))
		.filter((name) => !/(?:^|[-_.])(manifest|index|meta)$/i.test(name))
		.sort((a, b) => a.localeCompare(b));

	const uploads: Array<{ bundleName: string; mode: string; chunks: number }> = [];
	for (const bundleName of bundleNames) {
		const binPath = path.join(primedDir, `${bundleName}.bin`);
		const jsonPath = path.join(primedDir, `${bundleName}.json`);

		if (await exists(binPath)) {
			const payload = await fs.readFile(binPath);
			uploads.push(await uploadBundle(redis, bundleName, payload.toString('base64')));
			continue;
		}

		if (await exists(jsonPath)) {
			const jsonRaw = await fs.readFile(jsonPath, 'utf8');
			const gz = zlib.gzipSync(Buffer.from(jsonRaw, 'utf8'));
			uploads.push(await uploadBundle(redis, bundleName, gz.toString('base64')));
		}
	}

	return {
		bundleCount: uploads.length,
		uploads,
	};
}

export async function POST(request: NextRequest) {
	let body: RefreshRequestBody;
	try {
		body = (await request.json()) as RefreshRequestBody;
	} catch {
		return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
	}

	const action = body.action;
	if (!action || !['fetch-crds', 'sync-and-deploy-primed'].includes(action)) {
		return NextResponse.json({ ok: false, error: 'invalid-action' }, { status: 400 });
	}

	try {
		if (action === 'fetch-crds') {
			const maxCrds = Number(body.maxCrds || 30);
			const queries = parseQueries(body.queries ?? body.crds, maxCrds);
			const providedCrds = parseCrds(body.crds, maxCrds);
			const resolvedFromQueries = await resolveCrdsFromQueries(queries, maxCrds);

			const targetMap = new Map<string, FetchTarget>();
			for (const target of resolvedFromQueries.targets) {
				targetMap.set(`${target.source}:${target.type}:${target.crd}`, target);
			}

			for (const crd of providedCrds) {
				targetMap.set(`finra:individual:${crd}`, { crd, source: 'finra', type: 'individual' });
				targetMap.set(`sec:individual:${crd}`, { crd, source: 'sec', type: 'individual' });
				targetMap.set(`finra:firm:${crd}`, { crd, source: 'finra', type: 'firm' });
				targetMap.set(`sec:firm:${crd}`, { crd, source: 'sec', type: 'firm' });
			}

			const targets = Array.from(targetMap.values());
			if (!targets.length) {
				return NextResponse.json(
					{
						ok: false,
						error: 'no-valid-crds',
						queries,
						resolvedQueryCount: resolvedFromQueries.resolution.filter((entry) => entry.crdCount > 0).length,
						resolution: resolvedFromQueries.resolution,
					},
					{ status: 400 },
				);
			}

			const fetched = await fetchCrdsToCacheAndRedis(targets);
			return NextResponse.json({
				ok: true,
				action,
				queries,
				resolvedQueryCount: resolvedFromQueries.resolution.filter((entry) => entry.crdCount > 0).length,
				resolution: resolvedFromQueries.resolution,
				...fetched,
				at: new Date().toISOString(),
			});
		}

		const externalRawDir = String(body.externalRawDir || process.env.EXTERNAL_RAW_DIR || DEFAULT_EXTERNAL_RAW_DIR).trim();
		const syncResult = await syncExternalRawToLocal(externalRawDir);
		const deployResult = await deployPrimedBundlesToRedis();

		return NextResponse.json({
			ok: true,
			action,
			syncResult,
			deployResult,
			at: new Date().toISOString(),
		});
	} catch (error: any) {
		return NextResponse.json(
			{
				ok: false,
				error: error?.message || String(error),
				at: new Date().toISOString(),
			},
			{ status: 500 },
		);
	}
}
