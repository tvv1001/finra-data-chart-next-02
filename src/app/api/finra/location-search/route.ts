import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/simpleCache';
import { DEFAULT_HEADERS } from '@/lib/requestConstants';
import { logger } from '@/lib/logger';

function buildLocationSearchParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();

	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'type') continue;

		if (key === 'city' || key === 'state') {
			params.set(key, value.toUpperCase());
			continue;
		}
		if (key === 'q') {
			if (!searchParams.has('query')) params.set('query', value);
			continue;
		}

		params.set(key, value);
	}

	if (!params.has('query')) params.set('query', '*:*');
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	if (!params.has('nrows')) params.set('nrows', '25');
	if (!params.has('start')) params.set('start', '0');

	return params;
}

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const state = searchParams.get('state') || '';
		const type = searchParams.get('type') || 'individual';
		if (!state) return NextResponse.json({ error: 'state is required' }, { status: 400 });

		const params = buildLocationSearchParams(searchParams);
		const { default: axios } = await import('axios');
		const url = `https://api.brokercheck.finra.org/search/${encodeURIComponent(type)}?${params.toString()}`;
		const cacheKey = `finra:location:${type}:${params.toString()}`;
		const data = await cachedFetch(cacheKey, 600, async () => {
			const r = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 15000 });
			return r.data;
		});
		if (!data) return NextResponse.json({ hits: { hits: [] } });
		return NextResponse.json(data);
	} catch (err: any) {
		logger.error('location-search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to perform location search.' }, { status: 502 });
	}
}
