import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/simpleCache';
import { rememberRecentSeed } from '@/lib/seedStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { queueHydration } from '@/lib/hydration';
import { addRecordToSearchIndex } from '@/lib/localSearch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SUPPRESSED_SEC_FIRM_IDS = new Set(['4039']);

function buildFirmQueryParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();
	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		params.set(key, value);
	}
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	params.delete('nrows');
	return params;
}

function parseDetailPayload(data: any, contentKey = 'content') {
	if (!data) return null;

	const extractFromSource = (src: any) => {
		if (!src) return null;
		const raw = src[contentKey];
		let parsed = {};
		if (typeof raw === 'string') {
			try {
				parsed = JSON.parse(raw);
			} catch {
				/* ignore */
			}
		} else if (raw && typeof raw === 'object') {
			parsed = raw;
		}

		const merged = { ...src, ...parsed };
		if (merged[contentKey]) {
			delete merged[contentKey];
		}

		if (!merged.basicInformation) {
			const bi: any = {};
			const fid = merged.firmId || merged.firm_id || merged.id;
			if (fid) bi.firmId = fid;
			if (merged.firmName || merged.firm_name || merged.name) bi.firmName = merged.firmName || merged.firm_name || merged.name;
			if (merged.bcScope || merged.bc_scope) bi.bcScope = merged.bcScope || merged.bc_scope;
			if (merged.iaScope || merged.ia_scope) bi.iaScope = merged.iaScope || merged.ia_scope;
			if (merged.bdSECNumber || merged.bd_sec_number) bi.bdSECNumber = merged.bdSECNumber || merged.bd_sec_number;
			if (merged.iaSECNumber || merged.ia_sec_number) bi.iaSECNumber = merged.iaSECNumber || merged.ia_sec_number;
			if (Object.keys(bi).length) merged.basicInformation = bi;
		}

		const looksLikeDetail = merged.basicInformation || merged.firmId || merged.bdSECNumber || merged.firmName || merged.firmStatus || merged.disclosures || merged.directOwners;
		return looksLikeDetail ? merged : null;
	};

	if (data?.hits?.hits?.length) {
		return extractFromSource(data.hits.hits[0]?._source);
	}

	return extractFromSource(data);
}

function buildSecDocumentLinks(id: string) {
	if (!id) return [];
	return [
		{ label: 'SEC AdvisorInfo Summary', href: `https://adviserinfo.sec.gov/firm/summary/${id}` },
		{ label: 'Latest Form ADV filed', href: `https://reports.adviserinfo.sec.gov/reports/ADV/${id}/PDF/${id}.pdf` },
		{ label: 'SEC firm brochure', href: `https://adviserinfo.sec.gov/firm/brochure/${id}` },
		{ label: 'SEC Form CRS', href: `https://reports.adviserinfo.sec.gov/crs/crs_${id}.pdf` },
	];
}

function normalizeSecFirmId(value: string | number | null | undefined) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (/^8-\d+$/i.test(raw)) return raw;
	if (/^\d+$/.test(raw)) return `8-${raw}`;
	return raw;
}

function hasAnyItems(list: unknown) {
	return Array.isArray(list) && list.length > 0;
}

function hasPublicFinraFirmDetail(detail: any, basicInformation: Record<string, any> = {}) {
	if (!detail || typeof detail !== 'object') return false;

	const bcScope = String(detail?.bcScope || basicInformation?.bcScope || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (bcScope === 'notinscope') return false;
	if (bcScope) return true;

	if (
		String(detail?.isLegacy || basicInformation?.isLegacy || '')
			.trim()
			.toUpperCase() === 'Y'
	)
		return true;
	if (hasAnyItems(detail?.selfRegulatoryOrgs)) return true;
	if (Boolean(String(detail?.districtName || basicInformation?.districtName || '').trim())) return true;
	if (Boolean(String(detail?.bdSECNumber || detail?.bdSecNumber || basicInformation?.bdSECNumber || basicInformation?.bdSecNumber || '').trim())) return true;

	return false;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^\d{1,10}$/.test(id)) {
		return NextResponse.json({ error: 'Invalid firm ID.' }, { status: 400 });
	}
	const isMergedRoute = request.nextUrl.searchParams.get('merged') === '1';
	void rememberRecentSeed('firm', id).catch((error) => {
		logger.warn('failed to remember recent firm seed', { id, error: error?.message || String(error) });
	});

	try {
		const params = buildFirmQueryParams(new URL(request.url).searchParams);
		const queryString = params.toString();

		const fetchOptions = {
			headers: {
				'Accept': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'Referer': 'https://brokercheck.finra.org/',
			},
			next: { revalidate: 3600 },
		};

		const [bcData, secData, secPageData] = await Promise.allSettled([
			cachedFetch(`finra:firm:${id}`, 60 * 60 * 24, async () => {
				try {
					const url = `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&wt=json`;
					const res = await fetch(url, fetchOptions);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				} catch (err: any) {
					logger.warn('FINRA firm external fetch failed', { id, error: err.message });
					return undefined;
				}
			}),
			cachedFetch(`sec:firm:${id}`, 60 * 60 * 24, async () => {
				try {
					const url = `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`;
					const res = await fetch(url, { ...fetchOptions, headers: { ...fetchOptions.headers, Referer: 'https://adviserinfo.sec.gov/' } });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				} catch (err: any) {
					logger.warn('SEC firm external fetch failed', { id, error: err.message });
					return undefined;
				}
			}),
			cachedFetch(`sec:firm:summaryHtml:${id}`, 60 * 60 * 24, async () => {
				try {
					const url = `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(id)}`;
					const res = await fetch(url, { ...fetchOptions, headers: { ...fetchOptions.headers, Referer: 'https://adviserinfo.sec.gov/' } });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.text();
				} catch (err: any) {
					logger.warn('SEC firm summaryHtml fetch failed', { id, error: err.message });
					return undefined;
				}
			}),
		]);

		let bcDetail: any = null;
		if (bcData.status === 'fulfilled') {
			bcDetail = parseDetailPayload(bcData.value, 'content');
		}

		let secDetail: any = null;
		if (secData.status === 'fulfilled') {
			secDetail = parseDetailPayload(secData.value, 'iacontent');
		}

		if (!bcDetail && !secDetail) {
			return NextResponse.json({ found: false }, { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } });
		}

		let detail: any = bcDetail || secDetail;
		if (secDetail) {
			const sbi = secDetail.basicInformation || {};
			const dbi = detail.basicInformation || {};
			const mergeField = (key: string) => {
				if (!dbi[key] && sbi[key]) dbi[key] = sbi[key];
			};
			[
				'firmStatus',
				'firmStatusDate',
				'firmType',
				'firmSize',
				'regulator',
				'formedState',
				'formedDate',
				'districtName',
				'isLegacy',
				'iaSECNumber',
				'bdSECNumber',
				'bcScope',
				'iaScope',
				'fiscalMonthEndCode',
			].forEach(mergeField);
			if ((!dbi.otherNames || !dbi.otherNames.length) && sbi.otherNames?.length) dbi.otherNames = sbi.otherNames;
			detail.basicInformation = dbi;

			if (!detail.firmAddressDetails && secDetail.firmAddressDetails) detail.firmAddressDetails = secDetail.firmAddressDetails;
			if (!detail.iaFirmAddressDetails && secDetail.iaFirmAddressDetails) detail.iaFirmAddressDetails = secDetail.iaFirmAddressDetails;
			if (!detail.registrations && secDetail.registrations) detail.registrations = secDetail.registrations;
			if (!detail.registrationStatus && secDetail.registrationStatus) detail.registrationStatus = secDetail.registrationStatus;
			if (!detail.noticeFilings && secDetail.noticeFilings) detail.noticeFilings = secDetail.noticeFilings;
			if (!detail.directOwners?.length && secDetail.directOwners?.length) detail.directOwners = secDetail.directOwners;
			if (!detail.disclosures?.length && secDetail.disclosures?.length) detail.disclosures = secDetail.disclosures;
			if (!detail.brochures && secDetail.brochures) detail.brochures = secDetail.brochures;
		}

		const secFirmId = normalizeSecFirmId(detail?.basicInformation?.bdSECNumber || detail?.basicInformation?.bdSecNumber || detail?.bdSECNumber || detail?.bdSecNumber || id);

		const secHtml = secPageData?.status === 'fulfilled' ? secPageData.value : null;
		const secPageValid = false;
		detail.hasFinraData = hasPublicFinraFirmDetail(bcDetail, bcDetail?.basicInformation || {});

		const suppressSecLinks = SUPPRESSED_SEC_FIRM_IDS.has(id);
		detail.hasSecData = !suppressSecLinks && Boolean(secFirmId) && Boolean(secDetail || detail?.hasSecData);

		if (!suppressSecLinks && typeof detail.secSummaryDescription === 'string' && !detail.secSummaryDescription.trim()) {
			delete detail.secSummaryDescription;
		}

		if (!suppressSecLinks && Boolean(secFirmId) && (!Array.isArray(detail.secDocumentLinks) || !detail.secDocumentLinks.length)) {
			detail.secDocumentLinks = buildSecDocumentLinks(secFirmId);
		}

		if (!detail.hasSecData) {
			detail.secSummaryDescription = undefined;
			detail.secDocumentLinks = [];
		}

		// Queue background hydration of the external API to ensure cache stays hydrated
		queueHydration('firm', id);

		const searchIndexDetail = detail && typeof detail === 'object' ? detail : null;
		try {
			await addRecordToSearchIndex('finra', 'firm', id, searchIndexDetail);
		} catch (searchIndexErr: any) {
			logger.warn('failed to update local firm search index from detail route', { id, error: searchIndexErr?.message || String(searchIndexErr) });
		}

		if (isMergedRoute) {
			return NextResponse.json(
				{
					firmId: id,
					found: true,
					hasFinraData: detail.hasFinraData,
					hasSecData: detail.hasSecData,
					finraNode: detail,
					sources: {
						finra: bcDetail,
						sec: secDetail,
					},
					merged: detail,
				},
				{ headers: sharedCacheHeaders(3600) },
			);
		}

		return NextResponse.json(detail, { headers: sharedCacheHeaders(3600) });
	} catch (err: any) {
		logger.error('firm local detail route error', {
			id,
			error: err.message,
			stack: err.stack,
			isMergedRoute: request.nextUrl.searchParams.get('merged') === '1',
		});
		return NextResponse.json({ error: 'Failed to load local detail.', message: err.message }, { status: 500 });
	}
}
