import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph } from '@/lib/graphStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

let cachedGraphKey = '';
let cachedGraphAdj: Map<string, Set<string>> | null = null;

function getGraphCacheKey(graph: any) {
	return `${String(graph?.meta?.generated || '')}|${Number(graph?.nodes?.length || 0)}|${Number(graph?.links?.length || 0)}`;
}

function getAdjacency(graph: any): Map<string, Set<string>> {
	const key = getGraphCacheKey(graph);
	if (cachedGraphKey === key && cachedGraphAdj) {
		return cachedGraphAdj;
	}

	const adjacency = new Map<string, Set<string>>();
	for (const link of graph.links || []) {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!sourceId || !targetId) continue;
		if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
		if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
		adjacency.get(sourceId)?.add(targetId);
		adjacency.get(targetId)?.add(sourceId);
	}
	cachedGraphKey = key;
	cachedGraphAdj = adjacency;
	return adjacency;
}

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
		const { nodeId } = await params;
		const hops = normalizeHopsParam(request.nextUrl.searchParams.get('hops'));
		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const links: any[] = graph.links || [];

		const adjacency = getAdjacency(graph);

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
