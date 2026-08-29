import { NextRequest, NextResponse } from 'next/server';
import { getFirmConnectionsFromGraph } from '@/lib/graphConnections';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Cold reverse-index build can exceed default budget; precomputed adj keeps this fast.
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^\d{1,10}$/.test(id)) {
		return NextResponse.json({ error: 'Invalid firm ID.' }, { status: 400 });
	}

	try {
		const bucket = String(request.nextUrl.searchParams.get('bucket') || 'all').trim().toLowerCase();
		const { currentConnections, previousConnections } = await getFirmConnectionsFromGraph(id);
		const current = bucket === 'previous' ? [] : currentConnections || [];
		const previous = bucket === 'current' ? [] : previousConnections || [];

		return NextResponse.json(
			{
				firmId: id,
				found: true,
				currentConnections: current,
				previousConnections: previous,
			},
			{ headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=86400' } },
		);
	} catch (err: any) {
		logger.warn('Failed to load firm connections from graph route', { id, error: err?.message || String(err) });
		return NextResponse.json(
			{
				firmId: id,
				found: false,
				currentConnections: [],
				previousConnections: [],
				error: err?.message || String(err),
			},
			{ status: 200, headers: { 'Cache-Control': 'no-store' } },
		);
	}
}
