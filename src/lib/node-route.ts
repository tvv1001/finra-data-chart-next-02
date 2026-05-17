const NODE_ROUTE_BASE = '/node';

export function buildNodeRoutePath(nodeId: string | null | undefined) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return '/';
	return `${NODE_ROUTE_BASE}/${encodeURIComponent(normalizedNodeId)}`;
}

export function buildNodeRouteHref(nodeId: string | null | undefined, search = '') {
	const path = buildNodeRoutePath(nodeId);
	const normalizedSearch = search.startsWith('?') || !search ? search : `?${search}`;
	return `${path}${normalizedSearch}`;
}

export function parseNodeIdFromPathname(pathname: string | null | undefined) {
	const normalizedPathname = String(pathname || '').trim();
	if (!normalizedPathname || normalizedPathname === '/') return null;
	const match = /^\/node\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}
