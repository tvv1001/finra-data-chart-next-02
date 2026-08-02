import { getRecordDisplayName } from './recordDisplay';

export function resolveMainRecordTitle(options: {
	mainJsonLabel?: string | null;
	fallbackName?: string | null;
	entity?: 'individual' | 'firm' | string | null;
	id?: string | null;
	payload?: unknown;
}) {
	const normalizedLabel = String(options.mainJsonLabel || '').trim();
	const normalizedFallbackName = String(options.fallbackName || '').trim();
	const normalizedEntity = String(options.entity || '')
		.trim()
		.toLowerCase();
	const normalizedId = String(options.id || '').trim();
	const genericTitlePattern = /^(individual|firm)\s+\d+$/i;
	const placeholderLabelPattern = /^(result|record|individual|firm)$/i;
	const derivedName =
		normalizedEntity === 'firm' || normalizedEntity === 'individual' ? getRecordDisplayName(options.payload, normalizedEntity as 'individual' | 'firm', normalizedId || '0') : '';
	const hasUsefulLabel = Boolean(normalizedLabel && !genericTitlePattern.test(normalizedLabel) && !placeholderLabelPattern.test(normalizedLabel));
	const shouldPreferDerivedName = Boolean(derivedName && (!normalizedLabel || genericTitlePattern.test(normalizedLabel) || placeholderLabelPattern.test(normalizedLabel)));

	if (shouldPreferDerivedName) {
		return derivedName;
	}
	if (normalizedFallbackName && (!normalizedLabel || genericTitlePattern.test(normalizedLabel) || placeholderLabelPattern.test(normalizedLabel))) {
		return normalizedFallbackName;
	}
	if (hasUsefulLabel) {
		return normalizedLabel;
	}
	if (normalizedFallbackName) {
		return normalizedFallbackName;
	}
	if (derivedName) {
		return derivedName;
	}
	if (normalizedEntity === 'firm' || normalizedEntity === 'individual') {
		return `${normalizedEntity === 'firm' ? 'Firm' : 'Individual'} ${normalizedId || ''}`.trim();
	}
	return normalizedId ? `Record ${normalizedId}` : '';
}
