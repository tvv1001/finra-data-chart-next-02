import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/cache';
import { DEFAULT_HEADERS } from '@/lib/constants';
import { logger } from '@/lib/logger';

function buildSecFirmSearchParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();

	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'q') {
			if (!searchParams.has('query')) params.set('query', value);
			continue;
		}
		params.set(key, value);
	}

	if (!params.has('query')) return null;
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	if (!params.has('nrows')) params.set('nrows', '12');
	if (!params.has('start')) params.set('start', '0');

	return params;
}

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const params = buildSecFirmSearchParams(searchParams);
		if (!params) return NextResponse.json({ hits: { hits: [] } });

		const { default: axios } = await import('axios');
		const url = `https://api.adviserinfo.sec.gov/search/firm?${params.toString()}`;
		const cacheKey = `sec:firm-search:${params.toString()}`;
		const data = await cachedFetch(cacheKey, 600, async () => {
			const r = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 15000 });
			return r.data;
		});
		if (!data) return NextResponse.json({ hits: { hits: [] } });
		return NextResponse.json(data);
	} catch (err: any) {
		logger.error('sec-search-firm error', { error: err.message });
		return NextResponse.json({ error: 'Failed to search SEC firms.' }, { status: 502 });
	}
}
