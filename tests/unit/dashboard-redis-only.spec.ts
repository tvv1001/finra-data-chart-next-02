import { describe, expect, it } from 'vitest';

import { buildInventoryTotalsFromCards, collectInventoryTotalsFromCacheKeys, shouldUseLocalFallback } from '../../src/app/api/dashboard/refresh/route';

describe('shouldUseLocalFallback', () => {
	it('never falls back to local cache cards for dashboard card listings', () => {
		expect(shouldUseLocalFallback(0, false)).toBe(false);
		expect(shouldUseLocalFallback(10, true)).toBe(false);
		expect(shouldUseLocalFallback(5000, false)).toBe(false);
	});

	it('derives people, firms, and unique totals from the Redis card set itself', () => {
		const totals = buildInventoryTotalsFromCards(
			[
				{ id: '1', entity: 'individual', files: 1, sources: [{ source: 'finra', status: 'ok' }] },
				{ id: '2', entity: 'individual', files: 1, sources: [{ source: 'sec', status: 'ok' }] },
				{ id: '10', entity: 'firm', files: 1, sources: [{ source: 'finra', status: 'ok' }] },
			],
			'redis',
		);

		expect(totals).toEqual({
			people: 2,
			firms: 1,
			unique: 3,
			source: 'redis',
		});
	});

	it('counts unique people and firms from full Redis cache keys', () => {
		const totals = collectInventoryTotalsFromCacheKeys(['finra:individual:1', 'sec:individual:2', 'finra:firm:10', 'sec:firm:10', 'finra:individual:1']);

		expect(totals).toEqual({
			people: 2,
			firms: 1,
			unique: 3,
			source: 'redis',
		});
	});
});
