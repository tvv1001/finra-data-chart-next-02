import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph } from '@/lib/graphStore';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeText(value: unknown) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function collectSearchableNodeKeys(node: any) {
	const basic = node?.basicInformation || {};
	return [
		node?.id,
		node?.label,
		node?.name,
		node?.crd,
		node?.firmId,
		node?.bdSecNumber,
		node?.iaSecNumber,
		basic?.individualId,
		basic?.firmId,
		basic?.name,
		basic?.bdSECNumber,
		basic?.iaSECNumber,
		[basic?.firstName, basic?.middleName, basic?.lastName].filter(Boolean).join(' '),
		...(Array.isArray(node?.otherNames) ? node.otherNames : []),
		...(Array.isArray(basic?.otherNames) ? basic.otherNames : []),
	]
		.map((value) => normalizeText(value))
		.filter(Boolean);
}

function nodeMatchesQuery(node: any, query: string) {
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return false;
	return collectSearchableNodeKeys(node).some((key) => key.includes(normalizedQuery));
}

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const q = (searchParams.get('q') || '').toLowerCase().trim();
		const type = searchParams.get('type') || 'all';
		const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);

		if (!q) return NextResponse.json({ nodes: [], links: [], matchedIds: [] });

		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const matchedNodes = nodes
			.filter((node) => {
				if (type !== 'all' && node.group !== type) return false;
				return nodeMatchesQuery(node, q);
			})
			.slice(0, limit);
		const matchedIds = new Set(matchedNodes.map((node) => String(node?.id || '').trim()).filter(Boolean));

		if (!matchedIds.size) {
			return NextResponse.json({ nodes: [], links: [], matchedIds: [] });
		}

		const links = (graph.links || []).filter((link: any) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			return matchedIds.has(sourceId) || matchedIds.has(targetId);
		});

		const includedNodeIds = new Set<string>(matchedIds);
		links.forEach((link: any) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			if (sourceId) includedNodeIds.add(sourceId);
			if (targetId) includedNodeIds.add(targetId);
		});

		return NextResponse.json({
			nodes: nodes.filter((node) => includedNodeIds.has(String(node?.id || '').trim())),
			links,
			matchedIds: Array.from(matchedIds),
		});
	} catch (err: any) {
		logger.error('graph-search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to search graph.' }, { status: 500 });
	}
}
