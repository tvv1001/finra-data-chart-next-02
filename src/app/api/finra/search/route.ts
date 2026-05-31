import { NextRequest, NextResponse } from 'next/server';
import { searchLocalIndex } from '@/lib/localSearch';
import { logger } from '@/lib/logger';

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
		const type = searchParams.get('type') || (searchParams.get('firm') ? 'firm' : 'individual');
		const params = buildFinraSearchParams(searchParams);
		if (!params) return NextResponse.json({ hits: { hits: [] } });

		const query = params.get('query') || '';
		const limit = Number.parseInt(params.get('nrows') || '12', 10) || 12;
		const offset = Number.parseInt(params.get('start') || '0', 10) || 0;
		const data = await searchLocalIndex('finra', type === 'firm' ? 'firm' : 'individual', query, { limit, offset });
		return NextResponse.json(data);
	} catch (err: any) {
		logger.error('search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to search FINRA.' }, { status: 502 });
	}
}
