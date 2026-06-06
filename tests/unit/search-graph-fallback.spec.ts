import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/graphStore', () => ({
	getFullGraph: vi.fn(),
}));

import { getFullGraph } from '@/lib/graphStore';
import { searchGraphFallback } from '@/lib/searchGraphFallback';

describe('graph search fallback', () => {
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
		const result = await searchGraphFallback('finra', 'individual', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.total).toBeGreaterThan(0);
		expect(result.response.docs.some((doc) => String(doc.id || '') === 'person:1222513')).toBe(true);
	});

	it('matches only top-level CRDs', async () => {
		const result = await searchGraphFallback('finra', 'individual', '1222513', { limit: 1000 });

		expect(result.total).toBe(1);
		expect(result.response.docs[0]?.id).toBe('person:1222513');
	});
});
