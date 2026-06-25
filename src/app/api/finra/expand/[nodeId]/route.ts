import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getNeighborsForNodes } from '@/lib/graphStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { tryLoadPersonCluster } from '@/lib/peopleClusterCache';
import { searchLocalIndex } from '@/lib/localSearch';

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

function decodeNodeId(value: string | null | undefined): string {
	const raw = String(value || '').trim();
	if (!raw) return '';
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ nodeId: string }> }) {
	try {
		const { nodeId: rawNodeId } = await params;
		const nodeId = decodeNodeId(rawNodeId);
		const hops = normalizeHopsParam(request.nextUrl.searchParams.get('hops'));
		const strictExpansion = isStrictExpansionRequest(request.nextUrl.searchParams.get('strict'));
		const baseUrl = new URL(request.url).origin;

		// Support multiple node IDs via query param 'ids' (comma-separated)
		const extraIds =
			request.nextUrl.searchParams
				.get('ids')
				?.split(',')
				.map((id) => decodeNodeId(id))
				.filter(Boolean) || [];
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

		// If expanding a firm, also search for individuals who work there
		if (nodeId.startsWith('firm:') && hops === 1) {
			try {
				const firmId = nodeId.replace(/^firm:/, '');
				// First try searching by firm ID (more accurate if indexed)
				const searchById = await searchLocalIndex('finra', 'individual', firmId, { limit: 100, baseUrl });
				
				const hits = searchById.results || [];
				
				// If no hits by ID, try by firm name from the firm node itself
				let firmNode = result.nodes.find(n => n.id === nodeId);
				if (hits.length === 0 && firmNode && firmNode.label) {
					const searchByName = await searchLocalIndex('finra', 'individual', firmNode.label, { limit: 100, baseUrl });
					hits.push(...(searchByName.results || []));
				}

				const seenNodeIds = new Set(result.nodes.map(n => n.id));
				
				// Ensure the firm node itself is present in result.nodes
				if (!seenNodeIds.has(nodeId)) {
					let firmLabel = `Firm ${firmId}`;
					if (redisUrl && redisToken) {
						try {
							const redis = new Redis({ url: redisUrl, token: redisToken });
							const cachedFirm = await redis.get<any>(`finra:firm:${firmId}`);
							if (cachedFirm) {
								const cachedHits = cachedFirm?.hits?.hits || [];
								const rawDetail = cachedHits.length > 0 ? (cachedHits[0]?._source?.content || cachedHits[0]?._source) : cachedFirm;
								const parsed = typeof rawDetail === 'string' ? JSON.parse(rawDetail) : rawDetail;
								const bi = parsed?.basicInformation || parsed || {};
								firmLabel = bi.firmName || bi.name || firmLabel;
							}
						} catch (e) {
							console.warn(`Expansion API: Failed to load firm details for node label`, e);
						}
					}
					firmNode = {
						id: nodeId,
						label: firmLabel,
						group: 'firm',
						firmId
					};
					result.nodes.push(firmNode);
					seenNodeIds.add(nodeId);
				}
				
				for (const hit of hits) {
					const crd = String(hit.ind_source_id || hit.ind_crd || '').trim();
					if (!crd) continue;
					const personId = `person:${crd}`;
					if (!seenNodeIds.has(personId)) {
						const label = [hit.ind_firstname, hit.ind_middlename, hit.ind_lastname].filter(Boolean).join(' ') || `CRD ${crd}`;
						result.nodes.push({
							id: personId,
							label,
							group: 'individual',
							crd,
							_source: 'expansion-search'
						});
						seenNodeIds.add(personId);
					}
					
					const linkExists = result.links.some(l => 
						(l.source?.id ?? l.source) === personId && 
						(l.target?.id ?? l.target) === nodeId
					);
					
					if (!linkExists) {
						result.links.push({
							source: personId,
							target: nodeId,
							relationship: 'employed_by',
							isCurrent: true
						});
					}
				}
			} catch (e) {
				console.warn(`Expansion API: firm employee search failed for ${nodeId}`, e);
			}
		}

		return NextResponse.json(result, { headers: sharedCacheHeaders(300) });
	} catch (err: any) {
		logger.error('expand error', { error: err.message });
		return NextResponse.json({ error: 'Failed to expand node.' }, { status: 500 });
	}
}
