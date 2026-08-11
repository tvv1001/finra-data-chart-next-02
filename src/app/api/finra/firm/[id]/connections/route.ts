import { NextRequest, NextResponse } from 'next/server';
import { getFirmConnectionsFromGraph } from '@/lib/graphConnections';
import { sharedCacheHeaders } from '@/lib/httpCache';
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
		const { currentConnections, previousConnections } = await getFirmConnectionsFromGraph(id);
		return NextResponse.json(
			{
				firmId: id,
				found: true,
				currentConnections: currentConnections || [],
				previousConnections: previousConnections || [],
			},
			{ headers: sharedCacheHeaders(3600) },
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
