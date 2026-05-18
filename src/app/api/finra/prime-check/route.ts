import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/cache';
import { DEFAULT_HEADERS } from '@/lib/constants';
import { getFullGraph, getRecentSeedsFromStore, getSeedBankFromStore } from '@/lib/graphStore';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

const DEFAULT_LIMIT = Number(process.env.FINRA_PRIME_BATCH_LIMIT || 24);
const DEFAULT_CONCURRENCY = Number(process.env.FINRA_PRIME_CONCURRENCY || 4);

const INDIVIDUAL_QUERY = new URLSearchParams({
	hl: 'true',
	includePrevious: 'true',
	wt: 'json',
}).toString();

const FIRM_QUERY = new URLSearchParams({
	hl: 'true',
	wt: 'json',
}).toString();

function isAuthorized(request: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	return request.headers.get('authorization') === `Bearer ${secret}`;
}

function summarizeStats(graph: any, seedBank: any) {
	const links = Array.isArray(graph?.links) ? graph.links.length : 0;
	return {
		people: seedBank?.counts?.individuals ?? 0,
		firms: seedBank?.counts?.firms ?? 0,
		entities: seedBank?.counts?.entities ?? 0,
		totalNodes: seedBank?.counts?.totalNodes ?? (Array.isArray(graph?.nodes) ? graph.nodes.length : 0),
		links,
		generated: graph?.meta?.generated ?? null,
		seedBankUpdatedAt: seedBank?.updatedAt ?? null,
	};
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
	let nextIndex = 0;
	const runWorker = async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			await worker(items[currentIndex]);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => runWorker()));
}

async function warmIndividual(crd: string) {
	const { default: axios } = await import('axios');
	await Promise.allSettled([
		cachedFetch(`finra:individual:${crd}:${INDIVIDUAL_QUERY}`, 60 * 60 * 24, async () => {
			const response = await axios.get(`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${INDIVIDUAL_QUERY}`, {
				headers: DEFAULT_HEADERS,
				timeout: 15000,
			});
			return response.data;
		}),
		cachedFetch(`sec:individual:${crd}:${INDIVIDUAL_QUERY}`, 60 * 60 * 24, async () => {
			const response = await axios.get(`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?${INDIVIDUAL_QUERY}`, {
				headers: DEFAULT_HEADERS,
				timeout: 15000,
			});
			return response.data;
		}),
	]);
}

async function warmFirm(id: string) {
	const { default: axios } = await import('axios');
	await Promise.allSettled([
		cachedFetch(`finra:firm:${id}:${FIRM_QUERY}`, 60 * 60 * 24, async () => {
			const response = await axios.get(`https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?${FIRM_QUERY}`, {
				headers: DEFAULT_HEADERS,
				timeout: 15000,
			});
			return response.data;
		}),
		cachedFetch(`sec:firm:${id}`, 60 * 60 * 24, async () => {
			const response = await axios.get(`https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`, {
				headers: DEFAULT_HEADERS,
				timeout: 15000,
			});
			return response.data;
		}),
		cachedFetch(`sec:firm:summaryHtml:${id}`, 60 * 60 * 24, async () => {
			const response = await axios.get(`https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(id)}`, {
				headers: DEFAULT_HEADERS,
				timeout: 15000,
			});
			return response.data;
		}),
	]);
}

function extractFdaDockets(detail: any) {
	const disclosures = Array.isArray(detail?.disclosures) ? detail.disclosures : [];
	const dockets = new Set<string>();

	for (const disclosure of disclosures) {
		const dd = disclosure?.disclosureDetail;
		if (!dd || typeof dd !== 'object' || Array.isArray(dd)) continue;
		const docket = String(dd.DocketNumberFDA || '').trim();
		if (docket) dockets.add(docket);
	}

	return Array.from(dockets);
}

async function fetchLocalJson(origin: string, path: string) {
	const response = await fetch(`${origin}${path}`, {
		headers: {
			'Accept': 'application/json',
			'x-finra-prime-check': '1',
		},
		cache: 'no-store',
	});

	let payload: any = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}

	if (!response.ok) {
		throw new Error(payload?.error || `HTTP ${response.status}`);
	}

	return payload;
}

export async function GET(request: NextRequest) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	const { searchParams } = new URL(request.url);
	const origin = request.nextUrl.origin;
	const limit = Number(searchParams.get('limit') || DEFAULT_LIMIT);
	const concurrency = Number(searchParams.get('concurrency') || DEFAULT_CONCURRENCY);

	const [beforeGraph, beforeSeedBank, recentSeeds] = await Promise.all([getFullGraph(), getSeedBankFromStore(), getRecentSeedsFromStore()]);
	const before = summarizeStats(beforeGraph, beforeSeedBank);

	const warmTargets = [
		...recentSeeds.individualIds.slice(0, limit).map((id) => ({ kind: 'individual' as const, id })),
		...recentSeeds.firmIds.slice(0, limit).map((id) => ({ kind: 'firm' as const, id })),
	].slice(0, Math.max(1, limit * 2));

	const results = {
		warmedIndividuals: 0,
		warmedFirms: 0,
		fdaChecks: {
			individualsScanned: 0,
			docketsQueued: 0,
			docketsChecked: 0,
			found: 0,
			blocked: 0,
			noResults: 0,
			failures: [] as Array<{ crd: string; docket: string; error: string }>,
		},
		failures: [] as Array<{ kind: 'individual' | 'firm'; id: string; error: string }>,
	};
	const seenFdaDockets = new Set<string>();

	try {
		await runWithConcurrency(warmTargets, concurrency, async (target) => {
			try {
				if (target.kind === 'individual') {
					await warmIndividual(target.id);
					results.warmedIndividuals += 1;
					results.fdaChecks.individualsScanned += 1;

					const detail = await fetchLocalJson(origin, `/api/finra/individual/${encodeURIComponent(target.id)}`);
					if (detail?.found === false) {
						return;
					}

					for (const docket of extractFdaDockets(detail)) {
						if (seenFdaDockets.has(docket)) continue;
						seenFdaDockets.add(docket);
						results.fdaChecks.docketsQueued += 1;

						try {
							const fdaResult = await fetchLocalJson(origin, `/api/finra/fda/${encodeURIComponent(docket)}`);
							results.fdaChecks.docketsChecked += 1;
							if (fdaResult?.blocked) {
								results.fdaChecks.blocked += 1;
							} else if (fdaResult?.found) {
								results.fdaChecks.found += 1;
							} else {
								results.fdaChecks.noResults += 1;
							}
						} catch (error: any) {
							results.fdaChecks.failures.push({
								crd: target.id,
								docket,
								error: String(error?.message || error),
							});
							logger.warn('prime-check FDA lookup failed', {
								crd: target.id,
								docket,
								error: error?.message || String(error),
							});
						}
					}
					return;
				}
				await warmFirm(target.id);
				results.warmedFirms += 1;
			} catch (error: any) {
				results.failures.push({
					kind: target.kind,
					id: target.id,
					error: String(error?.message || error),
				});
			}
		});
	} catch (error: any) {
		return NextResponse.json(
			{
				ok: false,
				error: String(error?.message || error),
				results,
				before,
				recentSeeds,
			},
			{
				status: 500,
				headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
			},
		);
	}

	const [afterGraph, afterSeedBank] = await Promise.all([getFullGraph(), getSeedBankFromStore()]);
	const after = summarizeStats(afterGraph, afterSeedBank);
	const changed = before.people !== after.people || before.firms !== after.firms || before.links !== after.links || before.totalNodes !== after.totalNodes;

	logger.info('prime-check completed', {
		mode: 'daily-usage-aware-prime-check',
		limit,
		concurrency,
		recentSeeds: {
			individualsQueued: recentSeeds.individualIds.length,
			firmsQueued: recentSeeds.firmIds.length,
			updatedAt: recentSeeds.updatedAt,
		},
		results: {
			warmedIndividuals: results.warmedIndividuals,
			warmedFirms: results.warmedFirms,
			failures: results.failures.length,
			fdaChecks: {
				individualsScanned: results.fdaChecks.individualsScanned,
				docketsQueued: results.fdaChecks.docketsQueued,
				docketsChecked: results.fdaChecks.docketsChecked,
				found: results.fdaChecks.found,
				blocked: results.fdaChecks.blocked,
				noResults: results.fdaChecks.noResults,
				failures: results.fdaChecks.failures.length,
			},
		},
		changed,
	});

	return NextResponse.json(
		{
			ok: true,
			mode: 'daily-usage-aware-prime-check',
			limit,
			concurrency,
			recentSeeds: {
				individualsQueued: recentSeeds.individualIds.length,
				firmsQueued: recentSeeds.firmIds.length,
				updatedAt: recentSeeds.updatedAt,
			},
			results,
			before,
			after,
			changed,
		},
		{
			headers: {
				'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			},
		},
	);
}
