import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph } from '@/lib/graphStore';
import { logger } from '@/lib/logger';
import { isValidLocationStateFilter, nodeMatchesLocationSearch, normalizeLocationStateFilter } from '@/lib/locationSearch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const location = (searchParams.get('location') || searchParams.get('q') || '').trim();
		const rawState = (searchParams.get('state') || '').trim();
		const type = (searchParams.get('type') || 'all').trim();
		const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1), 200);

		if (!location && !rawState) {
			return NextResponse.json({ nodes: [], links: [], matchedIds: [], totalMatches: 0 });
		}
		if (rawState && !isValidLocationStateFilter(rawState)) {
			return NextResponse.json({ error: 'State must be a valid two-letter US code or INT.' }, { status: 400 });
		}

		const stateFilter = normalizeLocationStateFilter(rawState);
		const graph = await getFullGraph();
		const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
		const links: any[] = Array.isArray(graph?.links) ? graph.links : [];

		const matchedNodes = nodes.filter((node) => {
			if (type !== 'all' && node?.group !== type) return false;
			return nodeMatchesLocationSearch(node, { locationQuery: location, stateFilter });
		});
		const limitedNodes = matchedNodes.slice(0, limit);
		const matchedIds = new Set(limitedNodes.map((node) => String(node?.id || '').trim()).filter(Boolean));

		const matchedLinks = links.filter((link) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			return matchedIds.has(sourceId) || matchedIds.has(targetId);
		});

		const includedNodeIds = new Set<string>(matchedIds);
		matchedLinks.forEach((link) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			if (sourceId) includedNodeIds.add(sourceId);
			if (targetId) includedNodeIds.add(targetId);
		});

		return NextResponse.json({
			nodes: nodes.filter((node) => includedNodeIds.has(String(node?.id || '').trim())),
			links: matchedLinks,
			matchedIds: Array.from(matchedIds),
			totalMatches: matchedNodes.length,
		});
	} catch (err: any) {
		logger.error('location-search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to perform location search.' }, { status: 500 });
	}
}
