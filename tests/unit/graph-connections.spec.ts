import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedis = {
	get: vi.fn(),
	mget: vi.fn(),
};

vi.mock('@/lib/redisCache', () => ({
	getRedisClient: () => mockRedis,
	setStringIfValid: vi.fn(async () => 'written'),
	decompressPayload: (value: string) => value,
}));

vi.mock('@/lib/firmEmploymentFromPrimed', () => ({
	lookupFirmEmploymentEdgesFromPrimed: vi.fn(async () => ({
		edges: [
			{
				personCrd: '821381',
				personName: 'FRANKLIN RUSSELL BEARD',
				isCurrent: false,
				startDate: '1/13/2001',
				endDate: '9/4/2002',
			},
		],
		source: 'bundle',
	})),
	getFirmEmploymentEdgesFromPrimed: vi.fn(async () => []),
}));

vi.mock('@/lib/officialFirmRoster', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/officialFirmRoster')>();
	return {
		...actual,
		fetchOfficialFirmRoster: vi.fn(async () => null),
	};
});

import {
	countFirmConnectionEntries,
	extractIndividualEmployerLinksFromDetail,
	firmConnectionsCacheKey,
	getFirmConnectionsFromGraph,
	mergeGraphConnectionEntries,
} from '@/lib/graphConnections';

describe('firm connection merge and cache', () => {
	beforeEach(() => {
		mockRedis.get.mockReset();
		mockRedis.mget.mockReset();
		mockRedis.get.mockResolvedValue(null);
		mockRedis.mget.mockResolvedValue([]);
	});

	it('builds the local firm cache key', () => {
		expect(firmConnectionsCacheKey('2525')).toBe('firm-connections:firm:2525');
	});

	it('extracts current and previous employer firm links from individual detail', () => {
		const links = extractIndividualEmployerLinksFromDetail({
			basicInformation: { firstName: 'Tim', lastName: 'Register' },
			currentEmployments: [{ firmId: 100, firmName: 'Current Firm', registrationBeginDate: '1/1/2020' }],
			previousEmployments: [
				{
					firmId: 7691,
					firmName: 'MERRILL LYNCH, PIERCE, FENNER & SMITH INCORPORATED',
					registrationBeginDate: '12/21/1982',
					registrationEndDate: '6/17/1983',
				},
			],
			previousIAEmployments: [{ firmId: 7691, firmName: 'Merrill', registrationBeginDate: '12/21/1982', registrationEndDate: '6/17/1983' }],
		});
		expect(links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ firmId: '100', isCurrent: true }),
				expect.objectContaining({
					firmId: '7691',
					isCurrent: false,
					startDate: '12/21/1982',
					endDate: '6/17/1983',
					sources: expect.arrayContaining(['finra', 'sec']),
				}),
			]),
		);
	});

	it('lets current employment win when the same firm appears in previous too', () => {
		const links = extractIndividualEmployerLinksFromDetail({
			currentEmployments: [{ firmId: '50', firmName: 'Now', registrationBeginDate: '1/1/2024' }],
			previousEmployments: [{ firmId: '50', firmName: 'Then', registrationBeginDate: '1/1/2020', registrationEndDate: '12/31/2023' }],
		});
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ firmId: '50', isCurrent: true });
		expect(links[0].endDate).toBeUndefined();
	});

	it('merges current and previous lists without dropping distinct people', () => {
		const merged = mergeGraphConnectionEntries([
			[{ individualId: '1', name: 'A', relationship: 'Current registration', isCurrent: true }],
			[
				{ individualId: '1', name: 'A', relationship: 'Current registration', isCurrent: true },
				{ individualId: '2', name: 'B', relationship: 'Previous registration', isCurrent: false },
			],
		]);
		expect(merged.currentConnections).toHaveLength(1);
		expect(merged.previousConnections).toHaveLength(1);
		expect(countFirmConnectionEntries(merged)).toBe(2);
	});

	it('prefers the local firm-connections roster over stale verified Redis payloads', async () => {
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === 'firm-connections:firm:2525:verified') {
				return '1';
			}
			if (key === 'firm-connections:firm:2525') {
				return JSON.stringify({
					currentConnections: [{ individualId: '999', name: 'Stale only', relationship: 'Current registration', isCurrent: true, evidence: ['stale'] }],
					previousConnections: [],
				});
			}
			return null;
		});
		const result = await getFirmConnectionsFromGraph('2525');
		expect(result.currentConnections.length).toBeGreaterThan(100);
		expect(result.currentConnections.some((entry) => entry.individualId === '100001')).toBe(true);
		expect(result.previousConnections.some((entry) => entry.individualId === '821381')).toBe(true);
	});

	it('does not let a thin primed redis cache hide the local firm-connections roster', async () => {
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey('2525')) {
				return {
					currentConnections: [],
					previousConnections: [
						{
							individualId: '821381',
							name: 'FRANKLIN RUSSELL BEARD',
							relationship: 'Previous registration',
							isCurrent: false,
							evidence: ['primed-bundle'],
						},
					],
				};
			}
			return null;
		});
		mockRedis.mget.mockImplementation(async (...keys: string[]) => keys.map(() => 'present'));

		const result = await getFirmConnectionsFromGraph('2525');
		expect(result.currentConnections.length).toBeGreaterThan(0);
		expect(result.previousConnections.length).toBeGreaterThan(1);
		expect(countFirmConnectionEntries(result)).toBeGreaterThanOrEqual(185);
		expect(result.previousConnections.some((entry) => entry.individualId === '821381')).toBe(true);
	});
});
