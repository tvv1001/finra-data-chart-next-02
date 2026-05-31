import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, getSeedBankFromStore } from '@/lib/graphStore';
import { getProfilesFromStore } from '@/lib/seedStore';
import { DEFAULT_EXPANSION_HOPS } from '@/lib/finra-graph-defaults';
import { sharedCacheHeaders } from '@/lib/httpCache';

let cachedGraphRouteKey = '';
let cachedGraphAdj: Map<string, string[]> | null = null;

function getGraphRouteCacheKey(graph: any) {
	return `${String(graph?.meta?.generated || '')}|${Number(graph?.nodes?.length || 0)}|${Number(graph?.links?.length || 0)}`;
}

function refreshGraphRouteCaches(graph: any) {
	const key = getGraphRouteCacheKey(graph);
	if (cachedGraphRouteKey === key && cachedGraphAdj) {
		return { adj: cachedGraphAdj };
	}

	const adj = new Map<string, string[]>();
	const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const links: any[] = Array.isArray(graph?.links) ? graph.links : [];

	nodes.forEach((node) => {
		const id = String(node?.id || '').trim();
		if (id) adj.set(id, []);
	});
	for (const l of links) {
		const s = String((l.source?.id ?? l.source) || '').trim();
		const t = String((l.target?.id ?? l.target) || '').trim();
		if (!s || !t) continue;
		if (!adj.has(s)) adj.set(s, []);
		if (!adj.has(t)) adj.set(t, []);
		adj.get(s)!.push(t);
		adj.get(t)!.push(s);
	}

	cachedGraphRouteKey = key;
	cachedGraphAdj = adj;
	return { adj };
}

async function sampleNodesFromSeedBank(nodes: any[], limit: number) {
	try {
		const seedBank = await getSeedBankFromStore();
		// Prefer high-degree nodes from the seed bank for a more interesting initial graph
		const highDegreeIndividuals = (seedBank?.individualIds || []).slice(0, 100);
		const highDegreeFirms = (seedBank?.firmIds || []).slice(0, 100);

		const candidates = [...highDegreeIndividuals, ...highDegreeFirms];
		if (candidates.length < limit) {
			return sampleNodesRandomly(nodes, limit);
		}

		const sampledIds = new Set<string>();
		while (sampledIds.size < limit && candidates.length > 0) {
			const randomIndex = Math.floor(Math.random() * candidates.length);
			const randomId = candidates.splice(randomIndex, 1)[0];
			if (randomId) sampledIds.add(randomId);
		}

		const nodeMap = new Map(nodes.map((n) => [n.id, n]));
		return Array.from(sampledIds)
			.map((id) => nodeMap.get(id))
			.filter(Boolean);
	} catch {
		return sampleNodesRandomly(nodes, limit);
	}
}

function sampleNodesRandomly(nodes: any[], limit: number) {
	const count = Math.max(0, Math.min(limit, nodes.length));
	const sampled = nodes.slice();
	for (let i = sampled.length - 1; i > sampled.length - 1 - count; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[sampled[i], sampled[j]] = [sampled[j], sampled[i]];
	}
	return sampled.slice(sampled.length - count);
}

async function getProfilesData() {
	return getProfilesFromStore();
}

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const limit = parseInt(searchParams.get('limit') ?? '0', 10);
	const profileName = searchParams.get('profile') ?? undefined;

	if (limit > 0) {
		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const links: any[] = graph.links || [];
		const { adj: cachedAdj } = refreshGraphRouteCaches(graph);

		// Select seeds from the seed bank for a more deterministic and interesting initial subset.
		const seeds: any[] = await sampleNodesFromSeedBank(nodes, limit);
		const seedIds = new Set(seeds.map((n) => String(n.id || '').trim()));

		if (profileName) {
			const pr = await getProfilesData();
			if (Array.isArray(pr.profiles)) {
				const prof = pr.profiles.find((p: any) => p.name === profileName);
				if (prof) {
					const profileIds = [...(prof.individuals || []).map((crd: number) => `person:${crd}`), ...(prof.firms || []).map((crd: number) => `firm:${crd}`)];
					for (const id of profileIds) {
						const node = nodes.find((n) => n.id === id);
						if (node && !seedIds.has(id)) {
							seeds.push(node);
							seedIds.add(id);
						}
					}
				}
			}
		}

		const neighborIds = new Set(seedIds);
		const graphAdj = cachedAdj || new Map<string, string[]>();
		// For initial load, reduce hop count to speed up server response and reduce payload size.
		// The default of 3 can create a very large subset from a few seeds.
		const initialLoadHops = 1;
		let frontier = new Set(seedIds);
		for (let h = 0; h < initialLoadHops; h++) {
			const next = new Set<string>();
			for (const id of frontier) {
				for (const nid of graphAdj.get(id) || []) {
					if (!neighborIds.has(nid)) {
						neighborIds.add(nid);
						next.add(nid);
					}
				}
			}
			frontier = next;
			if (frontier.size === 0) break;
		}

		return NextResponse.json(
			{
				nodes: nodes.filter((n) => neighborIds.has(n.id)),
				links: links.filter((l) => {
					const s = l.source?.id ?? l.source;
					const t = l.target?.id ?? l.target;
					return neighborIds.has(s) && neighborIds.has(t);
				}),
				meta: {
					...(graph.meta || {}),
					subset: true,
					subsetSize: seeds.length,
					totalNodes: nodes.length,
					totalLinks: links.length,
				},
			},
			{ headers: sharedCacheHeaders(120) },
		);
	}

	if (profileName === 'custom') {
		return NextResponse.json(
			{
				nodes: [],
				links: [],
				meta: {
					sourceLabel: '(custom profile starts empty)',
					generated: new Date().toISOString(),
					totalIndividuals: 0,
					totalFirms: 0,
					totalEntities: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			},
			{ headers: sharedCacheHeaders(120) },
		);
	}

	// Return full graph from store (Redis on Vercel, filesystem locally)
	const graph = await getFullGraph();
	return NextResponse.json(graph, { headers: sharedCacheHeaders(120) });
}
