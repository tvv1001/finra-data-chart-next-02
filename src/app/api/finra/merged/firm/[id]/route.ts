import { NextRequest, NextResponse } from 'next/server';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[0-9]+$/.test(id)) {
		return NextResponse.json({ error: 'Invalid firm id' }, { status: 400 });
	}
	try {
		const response = await fetch(`${request.nextUrl.origin}/api/finra/firm/${encodeURIComponent(id)}`, {
			headers: { 'Accept': 'application/json', 'x-finra-merged-route': '1' },
			cache: 'no-store',
		});

		const detail = await response.json().catch(() => null);
		if (!response.ok || !detail || detail.found === false) {
			return NextResponse.json({ found: false }, { headers: sharedCacheHeaders(3600) });
		}

		return NextResponse.json(
			{
				firmId: id,
				found: true,
				finraNode: detail?.hasFinraData ? detail : null,
				evidence: [],
				merged: detail,
			},
			{ headers: sharedCacheHeaders(3600) },
		);
	} catch (err: any) {
		logger.error('merged firm error', { id, error: err?.message });
		return NextResponse.json({ error: 'Failed to compute merged firm' }, { status: 500 });
	}
}
