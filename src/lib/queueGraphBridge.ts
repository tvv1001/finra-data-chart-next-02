/**
 * One-shot dashboard → graph bridge for Queue graph CRDs.
 * Uses sessionStorage (not URL query params) so Graph navigation stays clean.
 */

export const QUEUE_GRAPH_BRIDGE_KEY = 'finra_queue_graph_bridge';

export type QueueGraphBridgePayload = {
	nodeIds: string[];
	writtenAt: number;
};

function normalizeBridgeNodeIds(nodeIds: unknown): string[] {
	if (!Array.isArray(nodeIds)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of nodeIds) {
		const id = String(raw || '').trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/** Persist Queue graph node ids for the next graph page load, then navigate. */
export function writeQueueGraphBridge(nodeIds: string[]): void {
	if (typeof window === 'undefined') return;
	const normalized = normalizeBridgeNodeIds(nodeIds);
	try {
		if (!normalized.length) {
			window.sessionStorage.removeItem(QUEUE_GRAPH_BRIDGE_KEY);
			return;
		}
		const payload: QueueGraphBridgePayload = {
			nodeIds: normalized,
			writtenAt: Date.now(),
		};
		window.sessionStorage.setItem(QUEUE_GRAPH_BRIDGE_KEY, JSON.stringify(payload));
	} catch {
		/* ignore quota / private mode */
	}
}

/** Read and clear the bridge payload (one-shot). */
export function consumeQueueGraphBridge(): string[] {
	if (typeof window === 'undefined') return [];
	try {
		const raw = window.sessionStorage.getItem(QUEUE_GRAPH_BRIDGE_KEY);
		window.sessionStorage.removeItem(QUEUE_GRAPH_BRIDGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as QueueGraphBridgePayload | string[];
		if (Array.isArray(parsed)) return normalizeBridgeNodeIds(parsed);
		return normalizeBridgeNodeIds(parsed?.nodeIds);
	} catch {
		try {
			window.sessionStorage.removeItem(QUEUE_GRAPH_BRIDGE_KEY);
		} catch {
			/* ignore */
		}
		return [];
	}
}
