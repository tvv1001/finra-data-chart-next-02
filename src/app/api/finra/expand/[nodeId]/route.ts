import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph } from '@/lib/graphStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeHopsParam(value: string | null): number | 'all' {
	if (typeof value === 'string' && value.trim().toLowerCase() === 'all') {
		return 'all';
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return 1;
	}

	return Math.floor(parsed);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ nodeId: string }> }) {
	try {
		const rawParams = await params;
		const nodeId = typeof rawParams.nodeId === 'string' ? decodeURIComponent(rawParams.nodeId) : rawParams.nodeId;
		const hops = normalizeHopsParam(request.nextUrl.searchParams.get('hops'));
		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const links: any[] = graph.links || [];

		const adjacency = new Map<string, Set<string>>();
		for (const link of links) {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			if (!sourceId || !targetId) continue;
			if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
			if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
			adjacency.get(sourceId)?.add(targetId);
			adjacency.get(targetId)?.add(sourceId);
		}

		// Log adjacency state for debugging expand requests (helps identify
		// cases where the requested node isn't present in the link map).
		try {
			logger.info('expand request', { nodeId, adjacencySize: adjacency.size, hasNode: adjacency.has(nodeId) });
		} catch (e) {
			// ignore logging failures
		}

		const visitedIds = new Set<string>([nodeId]);
		const distanceById = new Map<string, number>([[nodeId, 0]]);
		const queue: string[] = [nodeId];

		for (let index = 0; index < queue.length; index += 1) {
			const currentId = queue[index];
			const currentDistance = distanceById.get(currentId) ?? 0;
			if (hops !== 'all' && currentDistance >= hops) continue;

			for (const neighborId of adjacency.get(currentId) || []) {
				if (visitedIds.has(neighborId)) continue;
				visitedIds.add(neighborId);
				distanceById.set(neighborId, currentDistance + 1);
				queue.push(neighborId);
			}
		}

		const resultNodes = nodes.filter((node) => visitedIds.has(node.id));
		const resultLinks = links.filter((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return visitedIds.has(sourceId) && visitedIds.has(targetId);
		});

		return NextResponse.json({ nodes: resultNodes, links: resultLinks }, { headers: sharedCacheHeaders(300) });
	} catch (err: any) {
		logger.error('expand error', { error: err.message });
		return NextResponse.json({ error: 'Failed to expand node.' }, { status: 500 });
	}
}
