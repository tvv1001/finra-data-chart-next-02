import { describe, expect, it } from 'vitest';

import { emitCanvasNodeSelectionEvents } from '../../src/lib/finra-graph-canvas';

describe('finra-graph canvas selection events', () => {
	it('dispatches detail-sync and route-sync events for direct canvas selections', () => {
		const received: string[] = [];
		const routeListener = () => {
			received.push('route-node-request');
		};
		const selectedListener = () => {
			received.push('selected-node-route');
		};

		window.addEventListener('finra:route-node-request', routeListener as EventListener);
		window.addEventListener('finra:selected-node-route', selectedListener as EventListener);
		try {
			emitCanvasNodeSelectionEvents('person:3102054');
			expect(received).toEqual(['route-node-request', 'selected-node-route']);
		} finally {
			window.removeEventListener('finra:route-node-request', routeListener as EventListener);
			window.removeEventListener('finra:selected-node-route', selectedListener as EventListener);
		}
	});

	it('skips detail-sync when the selection already originated from a route request', () => {
		const received: string[] = [];
		const routeListener = () => {
			received.push('route-node-request');
		};
		const selectedListener = () => {
			received.push('selected-node-route');
		};

		window.addEventListener('finra:route-node-request', routeListener as EventListener);
		window.addEventListener('finra:selected-node-route', selectedListener as EventListener);
		try {
			emitCanvasNodeSelectionEvents('firm:143571', { requestDetailSync: false });
			expect(received).toEqual(['selected-node-route']);
		} finally {
			window.removeEventListener('finra:route-node-request', routeListener as EventListener);
			window.removeEventListener('finra:selected-node-route', selectedListener as EventListener);
		}
	});
});
