import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getNeighborsForNodes } from '@/lib/graphStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { tryLoadPersonCluster } from '@/lib/peopleClusterCache';

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

function isStrictExpansionRequest(value: string | null): boolean {
	if (typeof value !== 'string') return false;
	const normalized = value.trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ nodeId: string }> }) {
	try {
		const { nodeId } = await params;
		const hops = normalizeHopsParam(request.nextUrl.searchParams.get('hops'));
		const strictExpansion = isStrictExpansionRequest(request.nextUrl.searchParams.get('strict'));

		// Support multiple node IDs via query param 'ids' (comma-separated)
		const extraIds = request.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) || [];
		const allIds = Array.from(new Set([nodeId, ...extraIds]));

		// Fast path for single person expansion (cluster lookup)
		if (!strictExpansion && allIds.length === 1 && hops === 1 && nodeId.startsWith('person:')) {
			try {
				const cluster = await tryLoadPersonCluster(nodeId.slice('person:'.length));
				if (cluster) {
					return NextResponse.json({ nodes: cluster.nodes || [], links: cluster.links || [] }, { headers: sharedCacheHeaders(300) });
				}
			} catch (error) {
				console.warn(`Expansion API: people-cluster lookup failed for ${nodeId}`, error);
			}
		}

		// Fast path for single node (Redis cache check)
		const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
		const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
		if (!strictExpansion && allIds.length === 1 && redisUrl && redisToken && hops === 1) {
			try {
				const redis = new Redis({ url: redisUrl, token: redisToken });
				const cached = await redis.get<any>(`finra:expand:${nodeId}:1`);
				if (cached) {
					return NextResponse.json(cached, { headers: sharedCacheHeaders(300) });
				}
			} catch (e) {
				console.warn(`Expansion API: Cache check failed for ${nodeId}`, e);
			}
		}

		const result = await getNeighborsForNodes(allIds, hops);
		return NextResponse.json(result, { headers: sharedCacheHeaders(300) });
	} catch (err: any) {
		logger.error('expand error', { error: err.message });
		return NextResponse.json({ error: 'Failed to expand node.' }, { status: 500 });
	}
}
