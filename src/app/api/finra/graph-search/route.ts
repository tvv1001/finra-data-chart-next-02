import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, saveGraph } from '@/lib/graphStore';
import { Redis as UpstashRedis } from '@upstash/redis';
import { logger } from '@/lib/logger';
import { searchLocalIndex } from '@/lib/localSearch';

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
			// No graph matches — search the local FINRA/SEC indexes and persist discovered nodes into the graph cache.
			try {
				const allHits = (
					await Promise.all([
						searchLocalIndex('finra', 'individual', q, { limit: 1000 }),
						searchLocalIndex('finra', 'firm', q, { limit: 1000 }),
						searchLocalIndex('sec', 'individual', q, { limit: 1000 }),
						searchLocalIndex('sec', 'firm', q, { limit: 1000 }),
					])
				).flatMap((result) => result?.hits?.hits || []);
				if (!allHits.length) return NextResponse.json({ nodes: [], links: [], matchedIds: [] });

				// Build nodes/links from hits (similar to client-side logic)
				const newNodes: any[] = [];
				const newLinks: any[] = [];
				const seenIds = new Set<string>();

				for (const hit of allHits) {
					const src = hit._source || hit;
					let parsed = src;
					if (typeof src?.content === 'string') {
						try {
							parsed = JSON.parse(src.content);
						} catch {
							parsed = src;
						}
					}

					const crd = String(parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || '').trim();
					if (crd) {
						const personId = `person:${crd}`;
						if (!seenIds.has(personId)) {
							seenIds.add(personId);
							const label =
								[
									parsed?.basicInformation?.firstName || src?.ind_firstname,
									parsed?.basicInformation?.middleName || src?.ind_middlename,
									parsed?.basicInformation?.lastName || src?.ind_lastname,
								]
									.filter(Boolean)
									.join(' ') || `CRD ${crd}`;
							newNodes.push({ id: personId, label, group: 'individual', crd, _source: 'local-search' });

							const emps = src?.ind_current_employments || src?.ind_ia_current_employments || [];
							for (const e of emps) {
								const fid = String(e?.firm_id || e?.firmId || '').trim();
								if (!fid) continue;
								const firmNodeId = `firm:${fid}`;
								if (!seenIds.has(firmNodeId)) {
									seenIds.add(firmNodeId);
									newNodes.push({ id: firmNodeId, label: e?.firm_name || e?.firmName || `Firm ${fid}`, group: 'firm', firmId: fid, _source: 'local-search' });
								}
								newLinks.push({ source: personId, target: firmNodeId, relationship: 'employed_by', isCurrent: true });
							}
						}
						continue;
					}

					const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();
					if (firmId) {
						const firmNodeId = `firm:${firmId}`;
						if (!seenIds.has(firmNodeId)) {
							seenIds.add(firmNodeId);
							newNodes.push({ id: firmNodeId, label: src?.firm_name || src?.firmName || `Firm ${firmId}`, group: 'firm', firmId, _source: 'local-search' });
						}
					}
				}

				// Merge into existing graph and persist
				try {
					const graph = await getFullGraph();
					const existingIds = new Set((graph.nodes || []).map((n: any) => String(n.id)));
					const addedNodeIds: string[] = [];
					for (const n of newNodes) {
						if (!existingIds.has(n.id)) {
							graph.nodes.push(n);
							addedNodeIds.push(n.id);
						}
					}
					for (const l of newLinks) graph.links.push(l);
					await saveGraph(graph);

					// Push a compact monitoring entry into Redis list finra:redis-monitor for auditing
					try {
						const url = process.env.UPSTASH_REDIS_REST_URL;
						const token = process.env.UPSTASH_REDIS_REST_TOKEN;
						if (url && token) {
							const r = new UpstashRedis({ url, token });
							const ts = new Date().toISOString();
							const entry = { ts, action: 'persist-local-search-hits', source: 'graph-search', added: addedNodeIds.length, sample: addedNodeIds.slice(0, 5) };
							await r.lpush('finra:redis-monitor', JSON.stringify(entry));
							await r.ltrim('finra:redis-monitor', 0, 199);
						}
					} catch (monErr) {
						// ignore monitoring errors
					}
				} catch (e) {
					// ignore persistence errors but continue returning nodes
				}

				return NextResponse.json({ nodes: newNodes, links: newLinks, matchedIds: Array.from(seenIds) });
			} catch (e: any) {
				logger.error('graph-search local index fallback failed', { error: e?.message || String(e) });
				return NextResponse.json({ nodes: [], links: [], matchedIds: [] });
			}
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
