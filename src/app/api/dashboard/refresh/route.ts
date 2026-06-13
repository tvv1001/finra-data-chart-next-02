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
	const resolution: Array<{ query: string; crdCount: number; crds: string[] }> = [];

	for (const query of queries) {
		if (resolved.size >= maxCrds) break;
		if (/^\d{1,10}$/.test(query)) {
			resolved.add(query);
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
				if (id) crdsForQuery.add(id);
			}
			for (const item of collectSearchItems(finraFirm)) {
				const id = extractNumericId(item, firmKeys);
				if (id) crdsForQuery.add(id);
			}
			for (const item of collectSearchItems(secIndividual)) {
				const id = extractNumericId(item, individualKeys);
				if (id) crdsForQuery.add(id);
			}
			for (const item of collectSearchItems(secFirm)) {
				const id = extractNumericId(item, firmKeys);
				if (id) crdsForQuery.add(id);
			}

			const crds = Array.from(crdsForQuery);
			for (const crd of crds) {
				if (resolved.size >= maxCrds) break;
				resolved.add(crd);
			}

			resolution.push({ query, crdCount: crds.length, crds: crds.slice(0, 25) });
		} catch {
			resolution.push({ query, crdCount: 0, crds: [] });
		}
	}

	return {
		crds: Array.from(resolved).slice(0, maxCrds),
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

async function fetchCrdsToCacheAndRedis(crds: string[]) {
	const results: FetchResultItem[] = [];
	const nationalRoot = path.join(process.cwd(), 'data', 'national');
	const rawRoot = path.join(process.cwd(), 'data', 'raw');

	for (const crd of crds) {
		const targets = [
			{
				source: 'finra' as const,
				type: 'individual' as const,
				url: `https://api.brokercheck.finra.org/search/individual/${crd}?hl=true&wt=json`,
				cacheFileName: `api.brokercheck.finra.org_search_individual_${crd}.json`,
				cacheDir: 'brokercheck.finra.org',
				redisKey: `finra:individual:${crd}:${DEFAULT_INDIVIDUAL_QUERY}`,
			},
			{
				source: 'sec' as const,
				type: 'individual' as const,
				url: `https://api.adviserinfo.sec.gov/search/individual/${crd}?wt=json`,
				cacheFileName: `api.adviserinfo.sec.gov_search_individual_${crd}.json`,
				cacheDir: 'adviserinfo.sec.gov',
				redisKey: `sec:individual:${crd}:${DEFAULT_INDIVIDUAL_QUERY}`,
			},
			{
				source: 'finra' as const,
				type: 'firm' as const,
				url: `https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&wt=json`,
				cacheFileName: `api.brokercheck.finra.org_search_firm_${crd}.json`,
				cacheDir: 'brokercheck.finra.org',
				redisKey: `finra:firm:${crd}:${DEFAULT_FIRM_QUERY}`,
			},
			{
				source: 'sec' as const,
				type: 'firm' as const,
				url: `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`,
				cacheFileName: `api.adviserinfo.sec.gov_search_firm_${crd}.json`,
				cacheDir: 'adviserinfo.sec.gov',
				redisKey: `sec:firm:${crd}:${DEFAULT_FIRM_QUERY}`,
			},
		];

		for (const target of targets) {
			try {
				const payload = await fetchJson(target.url);
				const nationalFile = path.join(nationalRoot, target.cacheDir, target.cacheFileName);
				const rawFile = path.join(rawRoot, target.cacheDir, target.cacheFileName);
				await Promise.all([writeJsonFile(nationalFile, payload), writeJsonFile(rawFile, payload)]);

				const redisWrite = await setStringIfValid(target.redisKey, JSON.stringify(payload), 60 * 60 * 24);

				results.push({
					crd,
					source: target.source,
					type: target.type,
					url: target.url,
					cacheFile: nationalFile,
					redisKey: target.redisKey,
					status: 'ok',
					redisWrite,
				});
			} catch (error: any) {
				results.push({
					crd,
					source: target.source,
					type: target.type,
					url: target.url,
					cacheFile: path.join(nationalRoot, target.cacheDir, target.cacheFileName),
					redisKey: target.redisKey,
					status: 'error',
					redisWrite: 'not-attempted',
					error: error?.message || String(error),
				});
			}
		}
	}

	const successCount = results.filter((item) => item.status === 'ok').length;
	const errorCount = results.length - successCount;

	return {
		summary: {
			crdCount: crds.length,
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
			const crds = Array.from(new Set([...providedCrds, ...resolvedFromQueries.crds])).slice(0, Math.max(1, Math.min(500, maxCrds)));
			if (!crds.length) {
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

			const fetched = await fetchCrdsToCacheAndRedis(crds);
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
