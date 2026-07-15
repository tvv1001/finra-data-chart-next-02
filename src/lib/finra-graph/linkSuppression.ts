// Shared suppression rules for external SEC/FINRA links.

const BROKEN_FINRA_FIRM_IDS = new Set(['134139', '298880', '314694', '325639']);
const SUPPRESSED_SEC_INDIV_IDS = new Set(['18040']);
const SUPPRESSED_SEC_FIRM_IDS = new Set(['2001', '4039']);

function normalizeExternalLinkLabel(value: unknown) {
	return String(value ?? '')
		.trim()
		.toLowerCase();
}

function hasSuppressedExternalLink(node: any, target: 'sec' | 'finra') {
	return Array.isArray(node?.suppressedExternalLinks) && node.suppressedExternalLinks.some((entry: unknown) => normalizeExternalLinkLabel(entry) === target);
}

function normalizeId(raw: unknown) {
	return String(raw ?? '')
		.replace(/^person[:_]/, '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
}

export function shouldSuppressSecLink(node: any, kind?: 'individual' | 'firm') {
	if (!node || typeof node !== 'object') return false;
	if (hasSuppressedExternalLink(node, 'sec')) return true;

	if (kind === 'individual') {
		const rawId = normalizeId(node?.crd || node?.basicInformation?.individualId || node?.individualId || node?.id);
		if (rawId && SUPPRESSED_SEC_INDIV_IDS.has(rawId)) return true;
	}

	if (kind === 'firm') {
		const rawFirmId = normalizeId(node?.firmId || node?.id);
		if (rawFirmId && SUPPRESSED_SEC_FIRM_IDS.has(rawFirmId)) return true;
	}

	return false;
}

export function shouldSuppressFinraLink(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (hasSuppressedExternalLink(node, 'finra')) return true;

	const rawFirmId = normalizeId(node?.firmId || node?.id);
	return rawFirmId ? BROKEN_FINRA_FIRM_IDS.has(rawFirmId) : false;
}

export { BROKEN_FINRA_FIRM_IDS, SUPPRESSED_SEC_FIRM_IDS, SUPPRESSED_SEC_INDIV_IDS };
