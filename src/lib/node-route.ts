const NODE_ROUTE_BASE = '/node';

function toNodeRouteSlug(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return '';
	const separatorIndex = normalizedNodeId.indexOf(':');
	if (separatorIndex < 0) return encodeURIComponent(normalizedNodeId);
	const prefix = normalizedNodeId.slice(0, separatorIndex).trim();
	const rawSuffix = normalizedNodeId.slice(separatorIndex + 1).trim();
	if (!prefix || !rawSuffix) return encodeURIComponent(normalizedNodeId);
	return `${encodeURIComponent(prefix)}-${encodeURIComponent(rawSuffix)}`;
}

function fromNodeRouteSlug(slug: string) {
	const normalizedSlug = String(slug || '').trim();
	if (!normalizedSlug) return null;

	try {
		const legacyNodeId = decodeURIComponent(normalizedSlug);
		if (legacyNodeId.includes(':')) return legacyNodeId;
	} catch {}

	const separatorIndex = normalizedSlug.indexOf('-');
	if (separatorIndex < 0) {
		try {
			return decodeURIComponent(normalizedSlug);
		} catch {
			return normalizedSlug;
		}
	}

	const encodedPrefix = normalizedSlug.slice(0, separatorIndex).trim();
	const encodedSuffix = normalizedSlug.slice(separatorIndex + 1).trim();
	if (!encodedPrefix || !encodedSuffix) {
		try {
			return decodeURIComponent(normalizedSlug);
		} catch {
			return normalizedSlug;
		}
	}

	try {
		return `${decodeURIComponent(encodedPrefix)}:${decodeURIComponent(encodedSuffix)}`;
	} catch {
		return `${encodedPrefix}:${encodedSuffix}`;
	}
}

export function normalizeNodeRouteId(nodeIdOrSlug: string | null | undefined) {
	const normalizedValue = String(nodeIdOrSlug || '').trim();
	if (!normalizedValue) return null;
	if (normalizedValue.includes(':')) return normalizedValue;
	return fromNodeRouteSlug(normalizedValue);
}

export function buildNodeRoutePath(nodeId: string | null | undefined) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return '/';
	return `${NODE_ROUTE_BASE}/${toNodeRouteSlug(normalizedNodeId)}`;
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
	return normalizeNodeRouteId(match[1]);
}
