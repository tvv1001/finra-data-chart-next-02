export function safeParseJson(value: unknown) {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

export function normalizeRenderablePayload(payload: unknown) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return payload;
	}

	const obj = payload as Record<string, any>;
	const parsedContent = safeParseJson(obj.content);
	const parsedIaContent = safeParseJson(obj.iacontent);
	const parsedMeta = safeParseJson(obj.meta);

	const merged = {
		...obj,
		...(parsedContent && typeof parsedContent === 'object' ? parsedContent : {}),
		...(parsedIaContent && typeof parsedIaContent === 'object' ? parsedIaContent : {}),
		...(parsedMeta && typeof parsedMeta === 'object' ? parsedMeta : {}),
	} as Record<string, any>;

	if (parsedContent && typeof parsedContent === 'object') delete merged.content;
	if (parsedIaContent && typeof parsedIaContent === 'object') delete merged.iacontent;
	if (parsedMeta && typeof parsedMeta === 'object') delete merged.meta;

	return merged;
}

export function renderJsonForDisplay(payload: unknown) {
	const parsed = safeParseJson(payload);
	const normalized = normalizeRenderablePayload(parsed);
	try {
		return JSON.stringify(normalized, null, 2);
	} catch {
		return String(normalized ?? '');
	}
}
