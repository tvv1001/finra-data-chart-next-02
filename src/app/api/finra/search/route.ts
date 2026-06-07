import { NextRequest, NextResponse } from 'next/server';
import { hasMinimumSearchQuery, searchLocalIndex } from '@/lib/localSearch';
import { logger } from '@/lib/logger';
import { searchGraphFallback } from '@/lib/searchGraphFallback';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function jsonNoStore(data: unknown, init: Parameters<typeof NextResponse.json>[1] = {}) {
	return NextResponse.json(data, {
		...init,
		headers: {
			'Cache-Control': 'no-store, max-age=0, must-revalidate',
			...(init?.headers || {}),
		},
	});
}

function buildFinraSearchParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();
	const rawRows = searchParams.get('rows');
	const rawPageSize = searchParams.get('pageSize');
	const rawPageNumber = searchParams.get('pageNumber');

	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'type' || key === 'firm') continue;
		if (key === 'q') {
			if (!searchParams.has('query')) params.set('query', value);
			continue;
		}
		if (key === 'rows') {
			if (!searchParams.has('nrows')) params.set('nrows', value);
			continue;
		}
		if (key === 'pageSize') {
			if (!searchParams.has('nrows')) params.set('nrows', value);
			continue;
		}
		if (key === 'pageNumber') continue;
		params.set(key, value);
	}

	if (!params.has('query')) return null;
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	if (!params.has('nrows') && rawRows) params.set('nrows', rawRows);
	if (!params.has('nrows') && rawPageSize) params.set('nrows', rawPageSize);
	if (!params.has('nrows')) params.set('nrows', '12');
	if (!params.has('start') && rawPageNumber) {
		const pageNumber = Number.parseInt(rawPageNumber, 10);
		const nrows = Number.parseInt(params.get('nrows') || '12', 10);
		if (Number.isFinite(pageNumber) && pageNumber > 0 && Number.isFinite(nrows) && nrows > 0) {
			params.set('start', String((pageNumber - 1) * nrows));
		}
	}
	if (!params.has('start')) params.set('start', '0');

	return params;
}

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const baseUrl = new URL(request.url).origin;
		const type = searchParams.get('type') || (searchParams.get('firm') ? 'firm' : 'individual');
		const params = buildFinraSearchParams(searchParams);
		if (!params) return jsonNoStore({ hits: { hits: [] } });

		const query = params.get('query') || '';
		if (!hasMinimumSearchQuery(query))
			return jsonNoStore({ hits: { hits: [] }, response: { docs: [], numFound: 0, start: 0 }, results: [], total: 0, currentPage: [], pageNumber: 1, pageSize: 0 });
		const limit = Math.min(Number.parseInt(params.get('nrows') || '12', 10) || 12, 200);
		const offset = Number.parseInt(params.get('start') || '0', 10) || 0;
		const entity = type === 'firm' ? 'firm' : 'individual';
		const data = await searchLocalIndex('finra', entity, query, { limit, offset, baseUrl });
		console.log('[search] Local index result:', { total: data.total, hasResults: data.results.length > 0 });
		if (data.total > 0) return jsonNoStore(data);

		console.log('[search] Local search returned 0, falling back to graph search...');
		const fallback = await searchGraphFallback('finra', entity, query, { limit, offset });
		console.log('[search] Graph fallback result:', { total: fallback.total, hasResults: fallback.results.length > 0, resultsLength: fallback.results?.length });
		if (fallback.total === 0) {
			console.log('[search] WARNING: Both local search and graph fallback returned 0 results');
		}
		return jsonNoStore(fallback);
	} catch (err: any) {
		logger.error('search error', { error: err.message });
		return jsonNoStore({ error: 'Failed to search FINRA.' }, { status: 502 });
	}
}
