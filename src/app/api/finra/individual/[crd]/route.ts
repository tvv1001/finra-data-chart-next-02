import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { cachedFetch } from '@/lib/simpleCache';
import { rememberRecentSeed } from '@/lib/seedStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { normalizeIndividualDetailFromSource } from '@/lib/individualDetail';
import { hasIndividualSourceCoverage, resolveIndividualSourceDetail } from '@/lib/sourceTruth';
import { queueHydration } from '@/lib/hydration';
import { addRecordToSearchIndex } from '@/lib/localSearch';

function parseDetailPayload(data: any, contentKey = 'content') {
	if (!data) return null;
	if (data?.hits?.hits?.length) {
		const source = data.hits.hits[0]?._source || {};
		try {
			return resolveIndividualSourceDetail(source)?.detail ?? null;
		} catch (err: any) {
			logger.warn('failed to resolve individual search hit detail', { error: err?.message || String(err) });
			return null;
		}
	}

	const raw = data?.[contentKey];
	if (raw != null) {
		try {
			return normalizeIndividualDetailFromSource({
				...data,
				...(typeof raw === 'string' ? JSON.parse(raw) : raw || {}),
			});
		} catch (error) {
			try {
				return normalizeIndividualDetailFromSource(data);
			} catch (err: any) {
				logger.warn('failed to normalize individual detail payload', { error: err?.message || String(err) });
				return null;
			}
		}
	}

	if (isPlainObject(data)) {
		const looksLikeDetail =
			data.basicInformation ||
			data.individualId ||
			data.firstName ||
			data.lastName ||
			data.bcScope ||
			data.iaScope ||
			data.disclosures ||
			data.currentEmployments ||
			data.previousEmployments;
		if (looksLikeDetail) {
			try {
				return normalizeIndividualDetailFromSource(data);
			} catch (err: any) {
				logger.warn('failed to normalize individual detail object', { error: err?.message || String(err) });
				return null;
			}
		}
	}

	return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergePreferPrimary(primary: unknown, secondary: unknown): unknown {
	if (primary == null || primary === '') return secondary;
	if (secondary == null || secondary === '') return primary;
	if (Array.isArray(primary) && Array.isArray(secondary)) {
		if (!primary.length) return secondary;
		if (!secondary.length) return primary;
		const seen = new Set(primary.map((item) => JSON.stringify(item)));
		return [
			...primary,
			...secondary.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		];
	}
	if (isPlainObject(primary) && isPlainObject(secondary)) {
		const merged: Record<string, unknown> = { ...primary };
		for (const [key, value] of Object.entries(secondary)) {
			merged[key] = key in merged ? mergePreferPrimary(merged[key], value) : value;
		}
		return merged;
	}
	return primary;
}

function buildIndividualQueryParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();
	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'includesPrevious' && !searchParams.has('includePrevious')) {
			params.set('includePrevious', value);
			continue;
		}
		params.set(key, value);
	}
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	if (!params.has('includePrevious')) params.set('includePrevious', 'true');
	params.delete('nrows');
	return params;
}

// determine whether parsed details contain a usable numeric identifier
function findNumericId(obj: any, candidates: string[]) {
	if (!obj || typeof obj !== 'object') return '';
	for (const key of candidates) {
		const v = obj[key];
		if (v == null) continue;
		const s = String(v).trim();
		if (/^\d+$/.test(s)) return s;
		if (/^8-\d+$/i.test(s)) return s;
	}
	// try nested basicInformation
	const bi = obj.basicInformation || obj.basic_information || obj.basic || null;
	if (bi && typeof bi === 'object') {
		for (const key of candidates) {
			const v = bi[key];
			if (v == null) continue;
			const s = String(v).trim();
			if (/^\d+$/.test(s)) return s;
			if (/^8-\d+$/i.test(s)) return s;
		}
	}
	return '';
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ crd: string }> }) {
	const { crd } = await params;
	if (!/^\d{1,10}$/.test(crd)) {
		return NextResponse.json({ error: 'Invalid CRD number.' }, { status: 400 });
	}
	const isMergedRoute = request.nextUrl.searchParams.get('merged') === '1';
	void rememberRecentSeed('individual', crd).catch((error) => {
		logger.warn('failed to remember recent individual seed', { crd, error: error?.message || String(error) });
	});

	try {
		const fetchQuery = 'hl=true&includePrevious=true&wt=json';
		const fetchOptions = {
			headers: {
				'Accept': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'Referer': 'https://brokercheck.finra.org/',
			},
			next: { revalidate: 3600 },
		};

		const requests = await Promise.allSettled([
			cachedFetch(`finra:individual:${crd}`, 60 * 60 * 24, async () => {
				try {
					const url = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`;
					const res = await fetch(url, fetchOptions);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				} catch (err: any) {
					logger.warn('FINRA external fetch failed', { crd, error: err.message });
					return undefined;
				}
			}),
			cachedFetch(`sec:individual:${crd}`, 60 * 60 * 24, async () => {
				try {
					const url = `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`;
					const res = await fetch(url, fetchOptions);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				} catch (err: any) {
					logger.warn('SEC external fetch failed', { crd, error: err.message });
					return undefined;
				}
			}),
		]);

		const finraData = requests[0].status === 'fulfilled' ? requests[0].value : null;
		const secData = requests[1].status === 'fulfilled' ? requests[1].value : null;

		const finraDetail = parseDetailPayload(finraData, 'content');
		const secDetail = parseDetailPayload(secData, 'iacontent');

		if (!finraDetail && !secDetail) {
			return NextResponse.json({ found: false, crd }, { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } });
		}

		const detail: any =
			finraDetail ?
				secDetail ? mergePreferPrimary(secDetail, finraDetail)
				:	finraDetail
			:	secDetail;

		if (!isPlainObject(detail)) {
			logger.warn('parsed individual detail is not an object', { crd, type: typeof detail });
			return NextResponse.json(
				{ found: false, crd, error: 'invalid-detail-shape' },
				{ status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
			);
		}

		const finraNumeric = finraDetail ? findNumericId(finraDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';
		const secNumeric = secDetail ? findNumericId(secDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';

		detail.hasFinraData = !!finraDetail && !!finraNumeric && hasIndividualSourceCoverage(finraDetail, 'finra');
		detail.hasSecData = !!secDetail && !!secNumeric && hasIndividualSourceCoverage(secDetail, 'sec');

		// Queue background hydration of the external API to ensure cache stays hydrated
		queueHydration('individual', crd);

		if (isMergedRoute) {
			return NextResponse.json(
				{
					crd,
					found: true,
					hasFinraData: detail.hasFinraData,
					hasSecData: detail.hasSecData,
					finraNode: detail,
					sources: {
						finra: finraDetail ? { bccontent: finraDetail } : null,
						sec: secDetail ? { iacontent: secDetail } : null,
					},
					merged: detail,
				},
				{ headers: sharedCacheHeaders(3600) },
			);
		}

		const searchIndexDetail = normalizeIndividualDetailFromSource(detail, crd);
		try {
			await addRecordToSearchIndex('finra', 'individual', crd, searchIndexDetail);
		} catch (searchIndexErr: any) {
			logger.warn('failed to update local individual search index from detail route', { crd, error: searchIndexErr?.message || String(searchIndexErr) });
		}

		const responseData: any = { found: true, crd };
		if (finraDetail) responseData.bccontent = finraDetail;
		if (secDetail) responseData.iacontent = secDetail;

		return NextResponse.json(responseData, { headers: sharedCacheHeaders(3600) });
	} catch (err: any) {
		logger.error('individual local detail route error', {
			crd,
			error: err.message,
			stack: err.stack,
		});
		return NextResponse.json(
			{
				error: 'Failed to load individual detail.',
				message: err.message,
				crd,
			},
			{ status: 500 },
		);
	}
}
