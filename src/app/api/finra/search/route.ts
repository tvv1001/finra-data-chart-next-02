import { NextRequest, NextResponse } from 'next/server';
import { searchLocalCache } from '@/lib/localSearch';
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
		const nrows = Number(params.get('nrows') || '12');
		const start = Number(params.get('start') || '0');
		const data = await searchLocalCache({
			query: params.get('query') || '',
			type: type === 'firm' ? 'firm' : 'individual',
			source: 'finra',
			start,
			limit: nrows,
		});
		return NextResponse.json(data);
	} catch (err: any) {
		logger.error('search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to search FINRA.' }, { status: 500 });
	}
}
