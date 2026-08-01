export function resolveMainRecordTitle(options: {
	mainJsonLabel?: string | null;
	fallbackName?: string | null;
	entity?: 'individual' | 'firm' | string | null;
	id?: string | null;
}) {
	const normalizedLabel = String(options.mainJsonLabel || '').trim();
	const normalizedFallbackName = String(options.fallbackName || '').trim();
	const normalizedEntity = String(options.entity || '')
		.trim()
		.toLowerCase();
	const normalizedId = String(options.id || '').trim();
	const genericTitlePattern = /^(individual|firm)\s+\d+$/i;

	if (normalizedFallbackName && (!normalizedLabel || genericTitlePattern.test(normalizedLabel))) {
		return normalizedFallbackName;
	}
	if (normalizedLabel && !genericTitlePattern.test(normalizedLabel)) {
		return normalizedLabel;
	}
	if (normalizedFallbackName) {
		return normalizedFallbackName;
	}
	if (normalizedEntity === 'firm' || normalizedEntity === 'individual') {
		return `${normalizedEntity === 'firm' ? 'Firm' : 'Individual'} ${normalizedId || ''}`.trim();
	}
	return normalizedId ? `Record ${normalizedId}` : '';
}
