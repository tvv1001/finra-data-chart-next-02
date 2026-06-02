import { NextRequest, NextResponse } from 'next/server';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[0-9]+$/.test(id)) {
		return NextResponse.json({ error: 'Invalid firm id' }, { status: 400 });
	}
	try {
		const targetUrl = new URL(`/api/finra/firm/${encodeURIComponent(id)}`, request.nextUrl.origin);
		targetUrl.searchParams.set('merged', '1');
		const response = await fetch(targetUrl, {
			headers: { 'Accept': 'application/json' },
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
				hasFinraData: !!detail?.hasFinraData,
				hasSecData: !!detail?.hasSecData,
				finraNode: detail?.finraNode || detail?.merged || detail,
				sources: detail?.sources || { finra: null, sec: null },
				evidence: [],
				merged: detail?.merged || detail?.finraNode || detail,
			},
			{ headers: sharedCacheHeaders(3600) },
		);
	} catch (err: any) {
		logger.error('merged firm error', { id, error: err?.message });
		return NextResponse.json({ error: 'Failed to compute merged firm' }, { status: 500 });
	}
}
