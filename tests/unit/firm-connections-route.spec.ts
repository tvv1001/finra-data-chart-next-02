import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getConnections } from '../../src/app/api/finra/firm/[id]/connections/route';
import { GET as getFirm } from '../../src/app/api/finra/firm/[id]/route';

vi.mock('@/lib/graphConnections', () => ({
	getFirmConnectionsFromGraph: vi.fn(async (id: string) => ({
		currentConnections: [
			{
				individualId: '1001',
				name: 'John Doe',
				relationship: 'Registered Representative',
				isCurrent: true,
			},
		],
		previousConnections: [
			{
				individualId: '1002',
				name: 'Jane Smith',
				relationship: 'Previous Representative',
				isCurrent: false,
			},
		],
	})),
}));

vi.mock('@/lib/cache', () => ({
	redis: {
		get: vi.fn(async () => null),
		set: vi.fn(async () => 'OK'),
	},
	getFromCache: vi.fn(async () => null),
	saveToCache: vi.fn(async () => {}),
}));

describe('firm connections route and deferConnections option', () => {
	it('returns firm connections from /api/finra/firm/[id]/connections', async () => {
		const request = new NextRequest('http://localhost:3000/api/finra/firm/13686/connections');
		const response = await getConnections(request, { params: Promise.resolve({ id: '13686' }) });
		expect(response.status).toBe(200);

		const data = await response.json();
		expect(data.found).toBe(true);
		expect(data.firmId).toBe('13686');
		expect(data.currentConnections).toHaveLength(1);
		expect(data.currentConnections[0].name).toBe('John Doe');
		expect(data.previousConnections).toHaveLength(1);
		expect(data.previousConnections[0].name).toBe('Jane Smith');
	});

	it('handles invalid firm id gracefully', async () => {
		const request = new NextRequest('http://localhost:3000/api/finra/firm/abc/connections');
		const response = await getConnections(request, { params: Promise.resolve({ id: 'abc' }) });
		expect(response.status).toBe(400);
	});
});
