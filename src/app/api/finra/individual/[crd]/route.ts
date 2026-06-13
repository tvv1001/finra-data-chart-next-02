import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { cachedFetch } from '@/lib/simpleCache';
import { rememberRecentSeed } from '@/lib/seedStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { normalizeIndividualDetailFromSource } from '@/lib/individualDetail';

function parseDetailPayload(data: any, contentKey = 'content') {
	if (!data) return null;
	if (data?.hits?.hits?.length) {
		const source = data.hits.hits[0]?._source || {};
		const raw = source?.[contentKey];
		try {
			return normalizeIndividualDetailFromSource({
				...source,
				...(typeof raw === 'string' ? JSON.parse(raw) : raw || {}),
			});
		} catch {
			return normalizeIndividualDetailFromSource(source);
		}
	}

	const raw = data?.[contentKey];
	if (raw != null) {
		try {
			return normalizeIndividualDetailFromSource({
				...data,
				...(typeof raw === 'string' ? JSON.parse(raw) : raw || {}),
			});
		} catch {
			return normalizeIndividualDetailFromSource(data);
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
		if (looksLikeDetail) return normalizeIndividualDetailFromSource(data);
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
		const params = buildIndividualQueryParams(new URL(request.url).searchParams);
		const queryString = params.toString();

		const requests = await Promise.allSettled([
			cachedFetch(`finra:individual:${crd}:${queryString}`, 60 * 60 * 24, async () => {
				try {
					const res = await axios.get(`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${queryString}`, {
						timeout: 10000,
					});
					return res.data;
				} catch (err) {
					logger.warn('FINRA external fetch failed', { crd, error: err instanceof Error ? err.message : 'unknown' });
					return undefined;
				}
			}),
			cachedFetch(`sec:individual:${crd}:${queryString}`, 60 * 60 * 24, async () => {
				try {
					const res = await axios.get(`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?${queryString}`, {
						timeout: 10000,
					});
					return res.data;
				} catch (err) {
					logger.warn('SEC external fetch failed', { crd, error: err instanceof Error ? err.message : 'unknown' });
					return undefined;
				}
			}),
		]);

		const finraData = requests[0].status === 'fulfilled' ? requests[0].value : null;
		const secData = requests[1].status === 'fulfilled' ? requests[1].value : null;

		if (requests[0].status === 'rejected') {
			logger.warn('individual FINRA local cache lookup failed', {
				crd,
				error: requests[0].reason?.message || String(requests[0].reason || 'unknown error'),
			});
		}
		if (requests[1].status === 'rejected') {
			logger.warn('individual SEC local cache lookup failed', {
				crd,
				error: requests[1].reason?.message || String(requests[1].reason || 'unknown error'),
			});
		}

		const finraDetail = parseDetailPayload(finraData, 'content');
		const secDetail = parseDetailPayload(secData, 'iacontent');
		if (!finraDetail && !secDetail) {
			return NextResponse.json({ found: false }, { status: 200, headers: sharedCacheHeaders(3600) });
		}

		const detail: any =
			finraDetail ?
				secDetail ? mergePreferPrimary(secDetail, finraDetail)
				:	finraDetail
			:	secDetail;

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

		const finraNumeric = finraDetail ? findNumericId(finraDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';
		const secNumeric = secDetail ? findNumericId(secDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';

		detail.hasFinraData = !!finraDetail && !!finraNumeric;
		detail.hasSecData = !!secDetail && !!secNumeric;

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

		// For non-merged route, return with bccontent wrapper to match SEC's iacontent naming
		const responseData: any = {};
		if (finraDetail) {
			responseData.bccontent = finraDetail;
		}
		if (secDetail) {
			responseData.iacontent = secDetail;
		}
		if (Object.keys(responseData).length === 0) {
			return NextResponse.json({ found: false }, { status: 200, headers: sharedCacheHeaders(3600) });
		}

		return NextResponse.json(responseData, { headers: sharedCacheHeaders(3600) });
	} catch (err: any) {
		logger.error('individual local detail route error', { crd, error: err.message });
		return NextResponse.json({ error: 'Failed to load local detail.' }, { status: 500 });
	}
}
