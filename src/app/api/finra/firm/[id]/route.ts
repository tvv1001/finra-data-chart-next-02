import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/cache';
import { DEFAULT_HEADERS } from '@/lib/constants';
import { rememberRecentSeed } from '@/lib/graphStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
	if (data?.hits?.hits?.length) {
		const raw = data.hits.hits[0]?._source?.[contentKey];
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
		}
	}

	const raw = data?.[contentKey];
	if (raw != null) {
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
		}
	}

	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const looksLikeDetail = data.basicInformation || data.firmId || data.bdSECNumber || data.firmName || data.firmStatus || data.disclosures || data.directOwners;
		if (looksLikeDetail) return data;
	}

	return null;
}

function extractHtmlMetaContent(html: string, attrName: string) {
	const regex = new RegExp(`<meta[^>]+(?:name|property)=["']${attrName}["'][^>]+content=["']([^"']+)["']`, 'i');
	const match = html.match(regex);
	return match ? match[1] : null;
}

function extractHtmlTitle(html: string) {
	const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
	return match ? match[1].trim() : null;
}

function isValidSecFirmSummaryPage(html: string, id: string) {
	if (!html || !id) return false;
	const invalidPatterns = [/page not found/i, /404/i, /not found/i, /access denied/i, /unauthorized/i];
	if (invalidPatterns.some((rx) => rx.test(html))) return false;
	const title = extractHtmlTitle(html);
	if (title && /firm summary|advisorinfo|adviserinfo/i.test(title)) return true;
	const bodyContains = /Firm Summary|AdvisorInfo|Firm Detail|SEC Investment Adviser/;
	return bodyContains.test(html);
}

function normalizeUrl(href: string, base = 'https://adviserinfo.sec.gov') {
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
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

function extractSecDocumentLinks(html: string, id: string) {
	if (!html || !id) return [];
	const links = new Map<string, string>();
	const regex = /href=["']([^"']+)["']/gi;
	let match;

	while ((match = regex.exec(html)) !== null) {
		const href = normalizeUrl(match[1]);
		if (
			href.includes(`/firm/summary/${id}`) ||
			href.includes(`/firm/brochure/${id}`) ||
			href.includes(`/reports.adviserinfo.sec.gov/reports/ADV/${id}/PDF/${id}.pdf`) ||
			href.includes(`/reports.adviserinfo.sec.gov/crs/crs_${id}.pdf`)
		) {
			links.set(href, href);
		}
	}

	return Array.from(links.keys()).map((href) => {
		const label =
			href.includes(`/firm/summary/${id}`) ? 'SEC AdvisorInfo Summary'
			: href.includes(`/reports.adviserinfo.sec.gov/reports/ADV/${id}/PDF/${id}.pdf`) ? 'Latest Form ADV filed'
			: href.includes(`/firm/brochure/${id}`) ? 'SEC firm brochure'
			: href.includes(`/reports.adviserinfo.sec.gov/crs/crs_${id}.pdf`) ? 'SEC Form CRS'
			: href;
		return { label, href };
	});
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^\d{1,10}$/.test(id)) {
		return NextResponse.json({ error: 'Invalid firm ID.' }, { status: 400 });
	}
	void rememberRecentSeed('firm', id).catch((error) => {
		logger.warn('failed to remember recent firm seed', { id, error: error?.message || String(error) });
	});

	try {
		const { default: axios } = await import('axios');
		const params = buildFirmQueryParams(new URL(request.url).searchParams);
		const queryString = params.toString();

		const bcUrl =
			queryString ?
				`https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?${queryString}`
			:	`https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}`;
		const secUrl = `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`;
		const secPageUrl = `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(id)}`;

		const [bcData, secData, secPageData] = await Promise.allSettled([
			cachedFetch(`finra:firm:${id}:${queryString}`, 60 * 60 * 24, async () => {
				const r = await axios.get(bcUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
				return r.data;
			}),
			cachedFetch(`sec:firm:${id}`, 60 * 60 * 24, async () => {
				const r = await axios.get(secUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
				return r.data;
			}),
			cachedFetch(`sec:firm:summaryHtml:${id}`, 60 * 60 * 24, async () => {
				const r = await axios.get(secPageUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
				return r.data;
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
			return NextResponse.json({ found: false }, { status: 200, headers: sharedCacheHeaders(3600) });
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

		let secHtml = secPageData?.status === 'fulfilled' ? secPageData.value : null;
		let secPageValid = isValidSecFirmSummaryPage(secHtml, id);
		detail.hasFinraData = hasPublicFinraFirmDetail(bcDetail, bcDetail?.basicInformation || {});

		if (!secPageValid && secFirmId && secFirmId !== id) {
			const normalizedSecPageUrl = `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(secFirmId)}`;
			const normalizedSecHtml = await cachedFetch(`sec:firm:summaryHtml:${secFirmId}`, 60 * 60 * 24, async () => {
				const r = await axios.get(normalizedSecPageUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
				return r.data;
			});
			secHtml = normalizedSecHtml;
			secPageValid = isValidSecFirmSummaryPage(secHtml, secFirmId);
		}

		detail.hasSecData = Boolean(secFirmId) && Boolean(secDetail || secPageValid);

		if (secPageValid) {
			const summaryDescription =
				extractHtmlMetaContent(secHtml, 'description') || extractHtmlMetaContent(secHtml, 'og:description') || extractHtmlMetaContent(secHtml, 'twitter:description');
			if (summaryDescription) {
				detail.secSummaryDescription = summaryDescription;
			}
			const pageLinks = extractSecDocumentLinks(secHtml, secFirmId);
			if (pageLinks.length) detail.secDocumentLinks = pageLinks;
		}

		if (detail.hasSecData && (!Array.isArray(detail.secDocumentLinks) || !detail.secDocumentLinks.length)) {
			detail.secDocumentLinks = buildSecDocumentLinks(secFirmId);
		}

		if (!detail.hasSecData) {
			detail.secSummaryDescription = undefined;
			detail.secDocumentLinks = [];
		}

		return NextResponse.json(detail, { headers: sharedCacheHeaders(3600) });
	} catch (err: any) {
		logger.error('firm proxy error', { id, error: err.message });
		return NextResponse.json({ error: 'Failed to fetch from FINRA.' }, { status: 502 });
	}
}
