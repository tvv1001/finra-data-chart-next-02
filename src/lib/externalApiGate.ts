function getExternalApiContext() {
	return String(process.env.EXTERNAL_API_CONTEXT || '')
		.trim()
		.toLowerCase();
}

function isExplicitlyEnabled() {
	const raw = String(process.env.EXTERNAL_API_DISABLED || '')
		.trim()
		.toLowerCase();
	return raw === '0' || raw === 'false';
}

export function canCallExternalApis() {
	return getExternalApiContext() === 'cronjob' || isExplicitlyEnabled();
}

export function setExternalApiContext(context: string | null | undefined) {
	if (context == null || String(context).trim() === '') {
		delete process.env.EXTERNAL_API_CONTEXT;
		return;
	}
	process.env.EXTERNAL_API_CONTEXT = String(context).trim().toLowerCase();
}
