import { describe, expect, it } from 'vitest';

import {
	buildCacheCardsFromRedisKeys,
	buildInventoryTotalsFromCards,
	chooseDisplayInventoryTotals,
	collectInventoryTotalsFromCacheKeys,
	filterRecentCardsForDisplay,
	resolveDashboardInventoryTotals,
	shouldUseLocalFallback,
	sortLatestCardsForDisplay,
} from '../../src/app/api/dashboard/refresh/route';

describe('filterRecentCardsForDisplay', () => {
	it('keeps only CRDs from the last 7 days when a recency window is requested', () => {
		const now = Date.now();
		const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
		const cards = [
			{ id: '100', entity: 'individual', updatedAt: now },
			{ id: '101', entity: 'individual', updatedAt: sevenDaysAgo + 60_000 },
			{ id: '102', entity: 'firm', updatedAt: sevenDaysAgo - 60_000 },
		];

		expect(filterRecentCardsForDisplay(cards, { now, lookbackDays: 7 })).toEqual([
			{ id: '100', entity: 'individual', updatedAt: now },
			{ id: '101', entity: 'individual', updatedAt: sevenDaysAgo + 60_000 },
		]);
	});
});

describe('sortLatestCardsForDisplay', () => {
	it('keeps the newest 20 cards without enforcing a 7-day recency window', () => {
		const cards = Array.from({ length: 25 }, (_, index) => ({
			id: String(100 + index),
			entity: index % 2 === 0 ? 'individual' : 'firm',
			updatedAt: 1_000_000 + (24 - index) * 60_000,
		}));

		const sorted = sortLatestCardsForDisplay(cards, { maxCards: 20 });

		expect(sorted).toHaveLength(20);
		expect(sorted[0]).toEqual({
			id: '100',
			entity: 'individual',
			updatedAt: 1_000_000 + 24 * 60_000,
		});
		expect(sorted.at(-1)).toEqual({
			id: '119',
			entity: 'firm',
			updatedAt: 1_000_000 + 5 * 60_000,
		});
	});
});

describe('chooseDisplayInventoryTotals', () => {
	it('prefers deduplicated Redis totals over raw primed-bundle counts', () => {
		const redisTotals = { people: 54_115, firms: 12_834, unique: 66_949, source: 'redis' as const };
		const primedTotals = { people: 40_940, firms: 23_503, unique: 64_443, source: 'primed-bundle' as const };

		expect(chooseDisplayInventoryTotals(redisTotals, primedTotals)).toEqual(redisTotals);
	});

	it('falls back to primed-bundle totals only when Redis totals are empty', () => {
		const redisTotals = { people: 0, firms: 0, unique: 0, source: 'redis' as const };
		const primedTotals = { people: 10, firms: 5, unique: 15, source: 'primed-bundle' as const };

		expect(chooseDisplayInventoryTotals(redisTotals, primedTotals)).toEqual(primedTotals);
	});
});

describe('resolveDashboardInventoryTotals', () => {
	it('prefers live Redis deduped counts over stale raw snapshots', () => {
		const redisTotals = { people: 54_115, firms: 12_834, unique: 66_949, source: 'redis' as const };
		const cachedDeduped = { people: 54_115, firms: 12_834, unique: 66_949, source: 'redis' as const };
		const staleRaw = { people: 40_940, firms: 23_503, unique: 64_443, source: 'primed-bundle' as const };

		expect(resolveDashboardInventoryTotals(redisTotals, cachedDeduped, staleRaw)).toEqual(redisTotals);
	});

	it('falls back to the deduped cache snapshot when live Redis counts are empty', () => {
		const redisTotals = { people: 0, firms: 0, unique: 0, source: 'redis' as const };
		const cachedDeduped = { people: 54_115, firms: 12_834, unique: 66_949, source: 'redis' as const };
		const staleRaw = { people: 40_940, firms: 23_503, unique: 64_443, source: 'primed-bundle' as const };

		expect(resolveDashboardInventoryTotals(redisTotals, cachedDeduped, staleRaw)).toEqual(cachedDeduped);
	});

	it('uses the raw snapshot only when no deduped cache exists', () => {
		const redisTotals = { people: 0, firms: 0, unique: 0, source: 'redis' as const };
		const cachedDeduped = { people: 0, firms: 0, unique: 0, source: 'redis' as const };
		const rawSnapshot = { people: 40_940, firms: 23_503, unique: 64_443, source: 'primed-bundle' as const };

		expect(resolveDashboardInventoryTotals(redisTotals, cachedDeduped, rawSnapshot)).toEqual(rawSnapshot);
	});
});

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

	it('builds dashboard cards from native Redis keys and collapses query-suffixed duplicates', () => {
		const cards = buildCacheCardsFromRedisKeys(
			['finra:individual:1:hl=true&includePrevious=true&wt=json', 'sec:individual:1', 'finra:individual:1', 'finra:firm:10:wt=json'],
			new Map([
				['individual:1', 'Ada Broker'],
				['firm:10', 'Example Capital'],
			]),
		);

		expect(cards).toEqual([
			{
				id: '1',
				entity: 'individual',
				files: 2,
				sources: [
					{ source: 'finra', status: 'ok' },
					{ source: 'sec', status: 'ok' },
				],
				name: 'Ada Broker',
			},
			{
				id: '10',
				entity: 'firm',
				files: 1,
				sources: [{ source: 'finra', status: 'ok' }],
				name: 'Example Capital',
			},
		]);
	});
});
