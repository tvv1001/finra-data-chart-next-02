import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph } from '@/lib/graphStore';
import { scoreSearchValues, searchLocalCache } from '@/lib/localSearch';
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

function scoreNodeQueryMatch(node: any, query: string) {
	return scoreSearchValues(query, collectSearchableNodeKeys(node));
}

function buildGraphResponseFromHits(allHits: any[], limit: number) {
	const newNodes: any[] = [];
	const newLinks: any[] = [];
	const seenIds = new Set<string>();

	for (const hit of allHits) {
		const src = hit?._source || hit;
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
				const otherNames = Array.from(
					new Set(
						[
							...(Array.isArray(src?.otherNames) ? src.otherNames : []),
							...(Array.isArray(src?.ind_other_names) ? src.ind_other_names : []),
							...(Array.isArray(parsed?.otherNames) ? parsed.otherNames : []),
							...(Array.isArray(parsed?.basicInformation?.otherNames) ? parsed.basicInformation.otherNames : []),
						]
							.map((value) => String(value || '').trim())
							.filter(Boolean),
					),
				);
				const label =
					[
						parsed?.basicInformation?.firstName || src?.ind_firstname,
						parsed?.basicInformation?.middleName || src?.ind_middlename,
						parsed?.basicInformation?.lastName || src?.ind_lastname,
					]
						.filter(Boolean)
						.join(' ') || `CRD ${crd}`;
				newNodes.push({ id: personId, label, group: 'individual', crd, otherNames, _source: 'local-search' });

				const emps = [
					...(Array.isArray(src?.ind_current_employments) ? src.ind_current_employments : []),
					...(Array.isArray(src?.ind_ia_current_employments) ? src.ind_ia_current_employments : []),
					...(Array.isArray(parsed?.currentEmployments) ? parsed.currentEmployments : []),
					...(Array.isArray(parsed?.currentIAEmployments) ? parsed.currentIAEmployments : []),
				];
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
				const otherNames = Array.from(
					new Set(
						[
							...(Array.isArray(src?.otherNames) ? src.otherNames : []),
							...(Array.isArray(src?.firm_other_names) ? src.firm_other_names : []),
							...(Array.isArray(parsed?.otherNames) ? parsed.otherNames : []),
							...(Array.isArray(parsed?.basicInformation?.otherNames) ? parsed.basicInformation.otherNames : []),
						]
							.map((value) => String(value || '').trim())
							.filter(Boolean),
					),
				);
				newNodes.push({ id: firmNodeId, label: src?.firm_name || src?.firmName || `Firm ${firmId}`, group: 'firm', firmId, otherNames, _source: 'local-search' });
			}
		}
		if (newNodes.length >= limit) break;
	}

	return { nodes: newNodes.slice(0, limit), links: newLinks, matchedIds: Array.from(seenIds).slice(0, limit) };
}

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const q = (searchParams.get('q') || '').toLowerCase().trim();
		const type = searchParams.get('type') || 'all';
		const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);

		if (!q) return NextResponse.json({ nodes: [], links: [], matchedIds: [] });

		const searchRequests = [
			...(type === 'all' || type === 'individual' ? [searchLocalCache({ query: q, type: 'individual', source: 'finra', limit })] : []),
			...(type === 'all' || type === 'individual' ? [searchLocalCache({ query: q, type: 'individual', source: 'sec', limit })] : []),
			...(type === 'all' || type === 'firm' ? [searchLocalCache({ query: q, type: 'firm', source: 'finra', limit })] : []),
			...(type === 'all' || type === 'firm' ? [searchLocalCache({ query: q, type: 'firm', source: 'sec', limit })] : []),
		];
		const searchResponses = await Promise.all(searchRequests);
		const localHits = searchResponses.flatMap((response) => response?.hits?.hits || []);
		if (localHits.length) {
			return NextResponse.json(buildGraphResponseFromHits(localHits, limit));
		}

		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const matchedNodes = nodes
			.map((node) => ({
				node,
				score: type !== 'all' && node.group !== type ? 0 : scoreNodeQueryMatch(node, q),
			}))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score || String(left.node?.id || '').localeCompare(String(right.node?.id || '')))
			.map((entry) => entry.node)
			.slice(0, limit);
		const matchedIds = new Set(matchedNodes.map((node) => String(node?.id || '').trim()).filter(Boolean));

		if (!matchedIds.size) return NextResponse.json({ nodes: [], links: [], matchedIds: [] });

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
