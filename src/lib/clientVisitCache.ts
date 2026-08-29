/**
 * Recently-visited record cache shared by the dashboard and the node graph.
 * Memory covers same-document navigations; IndexedDB survives dashboard ↔ graph reloads.
 */

const MEMORY_MAX = 40;
const IDB_NAME = 'finra-visit-cache';
const IDB_STORE = 'records';
const IDB_VERSION = 1;

const memory = new Map<string, unknown>();

function touchMemory(key: string, value: unknown) {
	memory.delete(key);
	memory.set(key, value);
	while (memory.size > MEMORY_MAX) {
		const oldest = memory.keys().next().value;
		if (oldest == null) break;
		memory.delete(oldest);
	}
}

export function visitDetailKey(entity: 'firm' | 'individual', id: string) {
	return `detail:${entity}:${String(id || '').trim()}`;
}

export function visitSnapshotKey(entity: 'firm' | 'individual', id: string) {
	return `snapshot:${entity}:${String(id || '').trim()}`;
}

export function visitConnectionsKey(firmId: string) {
	return `connections:firm:${String(firmId || '').trim()}`;
}

export function readVisitedSync<T = unknown>(key: string): T | null {
	if (!key) return null;
	const value = memory.get(key);
	return value == null ? null : (value as T);
}

function openVisitDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			const req = indexedDB.open(IDB_NAME, IDB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(IDB_STORE)) {
					db.createObjectStore(IDB_STORE);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

export async function readVisited<T = unknown>(key: string): Promise<T | null> {
	const mem = readVisitedSync<T>(key);
	if (mem != null) return mem;
	if (!key) return null;
	const db = await openVisitDb();
	if (!db) return null;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(IDB_STORE, 'readonly');
			const req = tx.objectStore(IDB_STORE).get(key);
			req.onsuccess = () => {
				const value = req.result;
				if (value != null) touchMemory(key, value);
				resolve(value == null ? null : (value as T));
			};
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

export function rememberVisited(key: string, value: unknown) {
	if (!key || value == null) return;
	touchMemory(key, value);
	void (async () => {
		const db = await openVisitDb();
		if (!db) return;
		try {
			const tx = db.transaction(IDB_STORE, 'readwrite');
			tx.objectStore(IDB_STORE).put(value, key);
		} catch {
			// ignore quota / clone errors on oversized payloads
		}
	})();
}
