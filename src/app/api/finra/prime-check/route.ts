import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/cache';
import { DEFAULT_HEADERS } from '@/lib/constants';
import { getFullGraph, getRecentSeedsFromStore, getSeedBankFromStore } from '@/lib/graphStore';

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

export async function GET(request: NextRequest) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	const { searchParams } = new URL(request.url);
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
		failures: [] as Array<{ kind: 'individual' | 'firm'; id: string; error: string }>,
	};

	try {
		await runWithConcurrency(warmTargets, concurrency, async (target) => {
			try {
				if (target.kind === 'individual') {
					await warmIndividual(target.id);
					results.warmedIndividuals += 1;
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
			changed: before.people !== after.people || before.firms !== after.firms || before.links !== after.links || before.totalNodes !== after.totalNodes,
		},
		{
			headers: {
				'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			},
		},
	);
}
