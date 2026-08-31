import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis } = vi.hoisted(() => ({
	mockRedis: {
		get: vi.fn(),
		set: vi.fn(),
	},
}));

vi.mock('@/lib/redisCache', () => ({
	getRedisClient: () => mockRedis,
}));

vi.mock('@/lib/redisAvailability', () => ({
	canWriteToRedis: () => true,
	isRedisCacheOnly: () => false,
}));

import { recordFirmReference } from '@/lib/ownerReferenceIndex';

describe('recordFirmReference', () => {
	beforeEach(() => {
		mockRedis.get.mockReset();
		mockRedis.set.mockReset();
	});

	it('skips live firm CRDs so they do not get written into the non-live index', async () => {
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === 'finra:firm:9321') return '{"ok":true}';
			return null;
		});

		await recordFirmReference({
			crd: '9321',
			firmName: 'MERRILL',
			name: 'Timothy Register',
			parentCrd: '1085996',
			parentType: 'individual',
		});

		expect(mockRedis.get).toHaveBeenCalledWith('finra:firm:9321');
		expect(mockRedis.set).not.toHaveBeenCalled();
	});

	it('writes scraped-only firm references that are not already live', async () => {
		mockRedis.get.mockResolvedValue(null);

		await recordFirmReference({
			crd: '999991',
			firmName: 'SCRAPED FIRM',
			name: 'Timothy Register',
			parentCrd: '1085996',
			parentType: 'individual',
		});

		expect(mockRedis.set).toHaveBeenCalledWith(
			'non-live-crds:firm:999991',
			expect.any(String),
			{ ex: expect.any(Number) },
		);
	});
});
