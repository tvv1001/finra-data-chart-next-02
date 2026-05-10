import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph } from '@/lib/graphStore';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const q = (searchParams.get('q') || '').toLowerCase().trim();
		const type = searchParams.get('type') || 'all';
		const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);

		if (!q) return NextResponse.json([]);

		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const results = nodes
			.filter((n) => {
				if (type !== 'all' && n.group !== type) return false;
				const name = (n.name || n.label || '').toLowerCase();
				return name.includes(q) || String(n.id).includes(q);
			})
			.slice(0, limit)
			.map((n) => ({
				id: n.id,
				name: n.name || n.label,
				group: n.group,
				crd: n.crd ?? null,
			}));

		return NextResponse.json(results);
	} catch (err: any) {
		logger.error('graph-search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to search graph.' }, { status: 500 });
	}
}
