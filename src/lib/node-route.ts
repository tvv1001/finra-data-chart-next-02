const NODE_ROUTE_BASE = '/node';
const DASHBOARD_ROUTE_BASE = '/dashboard';
const INDIVIDUAL_ROUTE_BASE = `${DASHBOARD_ROUTE_BASE}/individual`;
const FIRM_ROUTE_BASE = `${DASHBOARD_ROUTE_BASE}/firm`;

function splitNodeId(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return null;
	const separatorIndex = normalizedNodeId.indexOf(':');
	if (separatorIndex < 0) return null;
	const prefix = normalizedNodeId.slice(0, separatorIndex).trim();
	const suffix = normalizedNodeId.slice(separatorIndex + 1).trim();
	if (!prefix || !suffix) return null;
	return { prefix, suffix };
}

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
	const parts = splitNodeId(normalizedNodeId);
	if (parts?.prefix === 'person') return `/individual/${encodeURIComponent(parts.suffix)}`;
	if (parts?.prefix === 'firm') return `/firm/${encodeURIComponent(parts.suffix)}`;
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

	const dashboardIndividualMatch = /^\/dashboard\/individual\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (dashboardIndividualMatch) {
		try {
			return `person:${decodeURIComponent(dashboardIndividualMatch[1])}`;
		} catch {
			return `person:${dashboardIndividualMatch[1]}`;
		}
	}

	const dashboardFirmMatch = /^\/dashboard\/firm\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (dashboardFirmMatch) {
		try {
			return `firm:${decodeURIComponent(dashboardFirmMatch[1])}`;
		} catch {
			return `firm:${dashboardFirmMatch[1]}`;
		}
	}

	const individualMatch = /^\/individual\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (individualMatch) {
		try {
			return `person:${decodeURIComponent(individualMatch[1])}`;
		} catch {
			return `person:${individualMatch[1]}`;
		}
	}

	const firmMatch = /^\/firm\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (firmMatch) {
		try {
			return `firm:${decodeURIComponent(firmMatch[1])}`;
		} catch {
			return `firm:${firmMatch[1]}`;
		}
	}

	const legacyMatch = /^\/node\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (!legacyMatch) return null;
	return normalizeNodeRouteId(legacyMatch[1]);
}
