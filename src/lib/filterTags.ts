/**
 * Shared "connections filter" tag state used by both the dashboard's
 * Current/Previous Connections filter input (`src/app/dashboard/page.tsx`)
 * and the graph sidebar's "Filter connections…" input (`src/lib/finra-graph.ts`).
 *
 * Persisted to localStorage so the keyword/tags survive navigation (route
 * changes, reloads, switching between the dashboard and the graph page) and
 * are kept in sync across both surfaces (and across browser tabs) via the
 * `storage` event plus an in-page CustomEvent (storage events don't fire in
 * the tab that made the change).
 */

export const FILTER_TAGS_STORAGE_KEY = 'finra_connections_filter_tags';
export const FILTER_TEXT_STORAGE_KEY = 'finra_connections_filter_text';
export const FILTER_ENABLED_STORAGE_KEY = 'finra_connections_filter_enabled';
const FILTER_TAGS_EVENT = 'finra:filter-tags-changed';
const FILTER_TEXT_EVENT = 'finra:filter-text-changed';
const FILTER_ENABLED_EVENT = 'finra:filter-enabled-changed';

function hasWindow(): boolean {
	return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeTag(tag: string): string {
	return tag.trim().replace(/\s+/g, ' ');
}

export function getFilterTags(): string[] {
	if (!hasWindow()) return [];
	try {
		const raw = window.localStorage.getItem(FILTER_TAGS_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
	} catch {
		return [];
	}
}

export function setFilterTags(tags: string[]): string[] {
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const raw of tags) {
		const tag = normalizeTag(raw);
		if (!tag) continue;
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(tag);
	}
	if (hasWindow()) {
		try {
			window.localStorage.setItem(FILTER_TAGS_STORAGE_KEY, JSON.stringify(deduped));
			window.dispatchEvent(new CustomEvent(FILTER_TAGS_EVENT, { detail: deduped }));
		} catch {
			// ignore localStorage/CustomEvent errors (e.g. private browsing quota)
		}
	}
	return deduped;
}

export function addFilterTag(tag: string): string[] {
	return setFilterTags([...getFilterTags(), tag]);
}

export function removeFilterTag(tag: string): string[] {
	const key = tag.trim().toLowerCase();
	return setFilterTags(getFilterTags().filter((t) => t.toLowerCase() !== key));
}

export function clearFilterTags(): string[] {
	return setFilterTags([]);
}

export function getFilterText(): string {
	if (!hasWindow()) return '';
	try {
		return window.localStorage.getItem(FILTER_TEXT_STORAGE_KEY) || '';
	} catch {
		return '';
	}
}

export function setFilterText(text: string): void {
	if (!hasWindow()) return;
	try {
		if (text) window.localStorage.setItem(FILTER_TEXT_STORAGE_KEY, text);
		else window.localStorage.removeItem(FILTER_TEXT_STORAGE_KEY);
		window.dispatchEvent(new CustomEvent(FILTER_TEXT_EVENT, { detail: text }));
	} catch {
		// ignore
	}
}

/** Subscribes to changes in the committed filter tags (from this tab or others). Returns an unsubscribe fn. */
export function subscribeFilterTags(cb: (tags: string[]) => void): () => void {
	if (!hasWindow()) return () => {};
	const onCustom = (ev: Event) => cb((ev as CustomEvent<string[]>).detail ?? getFilterTags());
	const onStorage = (ev: StorageEvent) => {
		if (ev.key === FILTER_TAGS_STORAGE_KEY) cb(getFilterTags());
	};
	window.addEventListener(FILTER_TAGS_EVENT, onCustom as EventListener);
	window.addEventListener('storage', onStorage);
	return () => {
		window.removeEventListener(FILTER_TAGS_EVENT, onCustom as EventListener);
		window.removeEventListener('storage', onStorage);
	};
}

export function getFilterEnabled(): boolean {
	if (!hasWindow()) return true;
	try {
		const raw = window.localStorage.getItem(FILTER_ENABLED_STORAGE_KEY);
		if (raw == null) return true;
		return raw !== '0' && raw !== 'false';
	} catch {
		return true;
	}
}

export function setFilterEnabled(enabled: boolean): boolean {
	if (hasWindow()) {
		try {
			window.localStorage.setItem(FILTER_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
			window.dispatchEvent(new CustomEvent(FILTER_ENABLED_EVENT, { detail: enabled }));
		} catch {
			// ignore localStorage/CustomEvent errors (e.g. private browsing quota)
		}
	}
	return enabled;
}

/** Subscribes to the tags on/off toggle. Returns an unsubscribe fn. */
export function subscribeFilterEnabled(cb: (enabled: boolean) => void): () => void {
	if (!hasWindow()) return () => {};
	const onCustom = (ev: Event) => cb((ev as CustomEvent<boolean>).detail ?? getFilterEnabled());
	const onStorage = (ev: StorageEvent) => {
		if (ev.key === FILTER_ENABLED_STORAGE_KEY) cb(getFilterEnabled());
	};
	window.addEventListener(FILTER_ENABLED_EVENT, onCustom as EventListener);
	window.addEventListener('storage', onStorage);
	return () => {
		window.removeEventListener(FILTER_ENABLED_EVENT, onCustom as EventListener);
		window.removeEventListener('storage', onStorage);
	};
}

/** Subscribes to changes in the live (uncommitted) filter text. Returns an unsubscribe fn. */
export function subscribeFilterText(cb: (text: string) => void): () => void {
	if (!hasWindow()) return () => {};
	const onCustom = (ev: Event) => cb((ev as CustomEvent<string>).detail ?? getFilterText());
	const onStorage = (ev: StorageEvent) => {
		if (ev.key === FILTER_TEXT_STORAGE_KEY) cb(getFilterText());
	};
	window.addEventListener(FILTER_TEXT_EVENT, onCustom as EventListener);
	window.addEventListener('storage', onStorage);
	return () => {
		window.removeEventListener(FILTER_TEXT_EVENT, onCustom as EventListener);
		window.removeEventListener('storage', onStorage);
	};
}

/** True if `haystack` matches the filter: tags are OR'd together (any tag may match), and
 * the live text (if present) is applied as an additional AND filter on top of that OR match.
 * All comparisons are case-insensitive substring matches. */
export function matchesFilterTags(haystack: string, tags: string[], liveText?: string): boolean {
	const lower = haystack.toLowerCase();
	if (tags.length > 0 && !tags.some((tag) => lower.includes(tag.toLowerCase()))) return false;
	const trimmedLive = (liveText || '').trim().toLowerCase();
	if (trimmedLive && !lower.includes(trimmedLive)) return false;
	return true;
}

/** Empty focused input previews the full list. After the first typed character, tags + live
 * text apply again. After Enter commits a tag, stay filtered even if the input is still focused. */
export function shouldPreviewUnfilteredConnections(opts: {
	focused?: boolean;
	liveText?: string;
	justCommitted?: boolean;
}): boolean {
	if (opts.justCommitted) return false;
	if (!opts.focused) return false;
	return !(opts.liveText || '').trim();
}

/** When `enabled` is false or the input is in the empty-focus preview, every haystack passes. */
export function matchesConnectionsFilter(
	haystack: string,
	tags: string[],
	liveText?: string,
	enabled = true,
	previewUnfiltered = false,
): boolean {
	if (!enabled || previewUnfiltered) return true;
	return matchesFilterTags(haystack, tags, liveText);
}
