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
		const { currentConnections, previousConnections } = await getFirmConnectionsFromGraph(id);

		// Optional companion docs produced by scripts/generate_firm_connection_docs.js
		let docsById: Record<string, any> | null = null;
		try {
			const fs = await import('fs');
			const path = await import('path');
			const docsPath = path.join(process.cwd(), 'data', 'firm-connections', `${id}-docs.json`);
			if (fs.existsSync(docsPath)) {
				const raw = fs.readFileSync(docsPath, 'utf-8');
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed.entries)) {
					docsById = Object.fromEntries(parsed.entries.map((e: any) => [String(e.individualId), e]));
				}
			}
		} catch (e) {
			// best-effort; ignore
		}
		return NextResponse.json(
			{
				firmId: id,
				found: true,
				currentConnections: currentConnections || [],
				previousConnections: previousConnections || [],
				docs: docsById,
			},
			{ headers: { 'Cache-Control': 'no-store' } },
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
