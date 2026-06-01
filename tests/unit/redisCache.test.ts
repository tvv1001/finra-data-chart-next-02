import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setMock = vi.fn();
const typeMock = vi.fn();

vi.mock('@upstash/redis', () => {
	return {
		Redis: class Redis {
			constructor() {
				// no-op
			}
			type = typeMock;
			set = setMock;
			get = vi.fn(async () => null);
		},
	};
});

beforeEach(() => {
	vi.resetModules();
	setMock.mockClear();
	typeMock.mockClear();
});

describe('redisCache helper', () => {
	it('isEmptyHitsObj recognizes empty hits shapes', async () => {
		const { isEmptyHitsObj } = await import('@/lib/redisCache');
		expect(isEmptyHitsObj({ hits: { total: 0, hits: [] } })).toBe(true);
		expect(isEmptyHitsObj({ hits: { total: { value: 0 }, hits: [] } })).toBe(true);
		expect(isEmptyHitsObj({})).toBe(false);
		expect(isEmptyHitsObj(null)).toBe(false);
		expect(isEmptyHitsObj({ hits: { total: 1, hits: [] } })).toBe(false);
		expect(isEmptyHitsObj({ hits: { total: 0, hits: [{ id: 1 }] } })).toBe(false);
	});

	it('setStringIfValid skips empty hits and does not call redis.set', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://x';
		process.env.UPSTASH_REDIS_REST_TOKEN = 't';
		const { setStringIfValid } = await import('@/lib/redisCache');
		const raw = JSON.stringify({ hits: { total: 0, hits: [] } });
		const res = await setStringIfValid('finra:foo', raw, 10);
		expect(res).toBe('skipped-empty');
		expect(setMock).not.toHaveBeenCalled();
	});

	it('setStringIfValid skips non-string existing key types', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://x';
		process.env.UPSTASH_REDIS_REST_TOKEN = 't';
		typeMock.mockResolvedValue('list');
		const { setStringIfValid } = await import('@/lib/redisCache');
		const raw = JSON.stringify({ data: 1 });
		const res = await setStringIfValid('finra:bar', raw, 10);
		expect(res).toBe('skipped-nonstring');
		expect(setMock).not.toHaveBeenCalled();
	});

	it('setStringIfValid writes when type is none', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://x';
		process.env.UPSTASH_REDIS_REST_TOKEN = 't';
		typeMock.mockResolvedValue('none');
		const { setStringIfValid } = await import('@/lib/redisCache');
		const raw = JSON.stringify({ data: 1 });
		const res = await setStringIfValid('finra:baz', raw, 7);
		expect(res).toBe('written');
		expect(setMock).toHaveBeenCalled();
		expect(setMock.mock.calls[0][0]).toBe('finra:baz');
		expect(setMock.mock.calls[0][1]).toBe(raw);
		expect(setMock.mock.calls[0][2]).toMatchObject({ ex: 7 });
	});

	it('setIfValid writes object values when valid', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://x';
		process.env.UPSTASH_REDIS_REST_TOKEN = 't';
		typeMock.mockResolvedValue('none');
		const { setIfValid } = await import('@/lib/redisCache');
		const res = await setIfValid('finra:obj', { foo: 'bar' }, 9);
		expect(res).toBe('written');
		expect(setMock).toHaveBeenCalled();
		// JSON stringified value
		expect(setMock.mock.calls[0][1]).toBe(JSON.stringify({ foo: 'bar' }));
	});

	it('setIfValid skips empty object shapes', async () => {
		process.env.UPSTASH_REDIS_REST_URL = 'https://x';
		process.env.UPSTASH_REDIS_REST_TOKEN = 't';
		const { setIfValid } = await import('@/lib/redisCache');
		const res = await setIfValid('finra:obj2', { hits: { total: 0, hits: [] } }, 9);
		expect(res).toBe('skipped-empty');
		expect(setMock).not.toHaveBeenCalled();
	});
});
