import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/graphStore', () => ({
	getFullGraph: vi.fn(),
	saveGraph: vi.fn(),
}));

vi.mock('@/lib/localSearch', () => ({
	searchLocalIndex: vi.fn(async () => ({
		bucket: 'finra:individual',
		generatedAt: null,
		total: 0,
		hits: { total: 0, start: 0, hits: [] },
		response: { numFound: 0, start: 0, docs: [] },
		results: [],
		currentPage: [],
		pageNumber: 1,
		pageSize: 0,
	})),
}));

vi.mock('@/lib/individualDetail', () => ({
	normalizeIndividualDetailFromSource: vi.fn((value) => value),
}));

vi.mock('@upstash/redis', () => ({
	Redis: class RedisMock {
		async lpush() {
			return 0;
		}
		async ltrim() {
			return 0;
		}
	},
}));

import { getFullGraph } from '@/lib/graphStore';
import { GET } from '@/app/api/finra/graph-search/route';

describe('graph-search route', () => {
	beforeEach(() => {
		vi.mocked(getFullGraph).mockResolvedValue({
			nodes: [
				{
					id: 'person:1222513',
					label: 'Ronald Perry Mason',
					group: 'individual',
					crd: '1222513',
				},
				{
					id: 'person:999999',
					label: 'Randy Mayson',
					group: 'individual',
					crd: '999999',
				},
				{
					id: 'firm:39914',
					label: 'Mason Example Firm',
					group: 'firm',
					firmId: '39914',
				},
			],
			links: [],
		});
	});

	it('matches free-text node names like mason', async () => {
		const response = await GET(new NextRequest('http://localhost/api/finra/graph-search?q=mason'));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.matchedIds).toContain('person:1222513');
		expect(payload.matchedIds).toContain('firm:39914');
		expect(payload.matchedIds).not.toContain('person:999999');
		expect(payload.nodes.some((node: any) => node.id === 'person:1222513')).toBe(true);
		expect(payload.nodes.some((node: any) => node.id === 'firm:39914')).toBe(true);
	});

	it('matches top-level CRDs only', async () => {
		const response = await GET(new NextRequest('http://localhost/api/finra/graph-search?q=1222513'));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.matchedIds).toEqual(['person:1222513']);
		expect(payload.nodes.some((node: any) => node.id === 'person:1222513')).toBe(true);
	});
});
