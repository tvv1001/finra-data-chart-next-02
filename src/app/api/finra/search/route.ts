import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/cache';
import { DEFAULT_HEADERS } from '@/lib/constants';
import { logger } from '@/lib/logger';

function buildFinraSearchParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();

	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'type') continue;
		// frontend may pass `firm=1`; that should control the path, not be forwarded
		if (key === 'firm') continue;
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
		// Support legacy `firm=1` query from the frontend by treating it as type=firm
		const type = searchParams.get('type') || (searchParams.get('firm') ? 'firm' : 'individual');
		const params = buildFinraSearchParams(searchParams);
		if (!params) return NextResponse.json({ hits: { hits: [] } });

		const { default: axios } = await import('axios');
		const url = `https://api.brokercheck.finra.org/search/${encodeURIComponent(type)}?${params.toString()}`;
		const cacheKey = `finra:search:${type}:${params.toString()}`;
		const data = await cachedFetch(cacheKey, 600, async () => {
			const r = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 15000 });
			return r.data;
		});
		// If cachedFetch returned undefined (e.g. external APIs disabled or rate-limited)
		// return a safe empty structure so the client can continue without errors.
		if (!data) return NextResponse.json({ hits: { hits: [] } });
		return NextResponse.json(data);
	} catch (err: any) {
		logger.error('search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to search FINRA.' }, { status: 502 });
	}
}
