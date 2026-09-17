import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, graphFileExists, saveGraph } from '@/lib/graphStore';
import { logger } from '@/lib/logger';
import { stripSimState } from '@/lib/graphStore';
import { mergeGraphNodesForAppend, rewriteGraphLinksForNodeIdentity } from '@/lib/graphIdentity';

export async function POST(request: NextRequest) {
	const t0 = performance.now();
	try {
		const { nodes: newNodes = [], links: newLinks = [] } = await request.json();
		if (!Array.isArray(newNodes) || !Array.isArray(newLinks)) {
			return NextResponse.json({ error: 'nodes and links must be arrays' }, { status: 400 });
		}

		let graph: any;
		const t1 = performance.now(); console.log("[graph-append] parse JSON:", t1 - t0);
		const exists = await graphFileExists();
		if (exists) {
			graph = await getFullGraph();
		} else {
			graph = { nodes: [], links: [], meta: { generated: new Date().toISOString() } };
		}

		const existingNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
		const t2 = performance.now();
		console.log('[graph-append] getFullGraph:', t2 - t1);
		const mergeResult = mergeGraphNodesForAppend(
			existingNodes,
			newNodes.map((node) => stripSimState(node)),
		);
		const mergedNodes = mergeResult.nodes;
		// O(n) membership — the previous nested .some() was O(merged*existing) and
		// blocked the Next event loop after large text searches (~80k graph nodes).
		const existingIdSet = new Set(existingNodes.map((node) => node?.id).filter(Boolean));
		let added = 0;
		for (const node of mergedNodes) {
			if (node?.id && !existingIdSet.has(node.id)) added += 1;
		}
		const canonicalNodeIds = new Set(mergedNodes.map((node) => node.id));
		const linkKey = (l: any) => {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			return `${s}|${t}`;
		};
		const existingLinks = new Set((Array.isArray(graph.links) ? graph.links : []).map(linkKey));
		const t3 = performance.now();
		console.log('[graph-append] mergeGraphNodes:', t3 - t2);
		const rewrittenIncomingLinks = rewriteGraphLinksForNodeIdentity(newLinks, mergeResult.idRewriteMap);
		const addedLinks: any[] = [];
		for (const l of rewrittenIncomingLinks) {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			if (canonicalNodeIds.has(s) && canonicalNodeIds.has(t) && !existingLinks.has(linkKey(l))) {
				addedLinks.push({ source: s, target: t, type: l.type, relationship: l.relationship, isCurrent: l.isCurrent, startDate: l.startDate, endDate: l.endDate });
			}
		}

		const mergedLinks = [...graph.links, ...addedLinks];

		// Compute meta counts for UI display
		const totalIndividuals = mergedNodes.filter((n) => n.group === 'individual').length;
		const totalFirms = mergedNodes.filter((n) => n.group === 'firm').length;
		const totalEntities = mergedNodes.filter((n) => n.group === 'entity').length;
		const totalLinks = mergedLinks.length;

		const merged = {
			...graph,
			nodes: mergedNodes,
			links: mergedLinks,
			meta: {
				...(graph.meta || {}),
				generated: new Date().toISOString(),
				totalIndividuals,
				totalFirms,
				totalEntities,
				totalNodes: mergedNodes.length,
				totalLinks,
			},
		};

		const t4 = performance.now(); console.log("[graph-append] build Merged:", t4 - t3);
		await saveGraph(merged);
		const t5 = performance.now(); console.log("[graph-append] saveGraph:", t5 - t4);

		return NextResponse.json({ ok: true, addedNodes: added, addedLinks: addedLinks.length });
	} catch (err: any) {
		logger.error('graph-append error', { error: err.message });
		return NextResponse.json({ error: 'Failed to append to graph.' }, { status: 500 });
	}
}
