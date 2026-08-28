import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUEUE_GRAPH_BRIDGE_KEY, consumeQueueGraphBridge, writeQueueGraphBridge } from '../../src/lib/queueGraphBridge';

describe('queueGraphBridge', () => {
	beforeEach(() => {
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			value: {
				getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
				setItem: (key: string, value: string) => {
					storage.set(key, String(value));
				},
				removeItem: (key: string) => {
					storage.delete(key);
				},
			},
		});
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: globalThis,
		});
	});

	afterEach(() => {
		try {
			sessionStorage.removeItem(QUEUE_GRAPH_BRIDGE_KEY);
		} catch {
			/* ignore */
		}
	});

	it('writes and consumes Queue graph node ids once', () => {
		writeQueueGraphBridge(['person:1', 'firm:2', 'person:1', '']);
		expect(JSON.parse(sessionStorage.getItem(QUEUE_GRAPH_BRIDGE_KEY) || 'null')?.nodeIds).toEqual(['person:1', 'firm:2']);

		expect(consumeQueueGraphBridge()).toEqual(['person:1', 'firm:2']);
		expect(sessionStorage.getItem(QUEUE_GRAPH_BRIDGE_KEY)).toBeNull();
		expect(consumeQueueGraphBridge()).toEqual([]);
	});

	it('clears the bridge when given an empty list', () => {
		writeQueueGraphBridge(['person:9']);
		writeQueueGraphBridge([]);
		expect(sessionStorage.getItem(QUEUE_GRAPH_BRIDGE_KEY)).toBeNull();
	});
});
