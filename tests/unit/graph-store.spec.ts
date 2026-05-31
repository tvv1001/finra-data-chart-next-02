import { readFile, unlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { RECENT_SEEDS_FILE } from '@/lib/constants';
import { getRecentSeedsFromStore, rememberRecentSeed, saveRecentSeedsToStore } from '@/lib/graphStore';

async function withRecentSeedsFileRestore(run: () => Promise<void>) {
	const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
	const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
	delete process.env.UPSTASH_REDIS_REST_URL;
	delete process.env.UPSTASH_REDIS_REST_TOKEN;

	let originalContents: string | null = null;
	try {
		originalContents = await readFile(RECENT_SEEDS_FILE, 'utf-8');
	} catch {
		originalContents = null;
	}

	try {
		await run();
	} finally {
		if (originalContents === null) {
			await unlink(RECENT_SEEDS_FILE).catch(() => {});
		} else {
			await saveRecentSeedsToStore(JSON.parse(originalContents));
		}

		if (typeof previousRedisUrl === 'string') process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
		else delete process.env.UPSTASH_REDIS_REST_URL;
		if (typeof previousRedisToken === 'string') process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
		else delete process.env.UPSTASH_REDIS_REST_TOKEN;
	}
}

describe('graphStore recent seed ordering', () => {
	it('treats higher CRDs as newer recent seeds', async () => {
		await withRecentSeedsFileRestore(async () => {
			await saveRecentSeedsToStore({
				individualIds: ['100', '400', '250'],
				firmIds: ['12', '88', '20'],
				updatedAt: new Date().toISOString(),
			});

			await rememberRecentSeed('individual', '350');
			await rememberRecentSeed('firm', '99');

			const recentSeeds = await getRecentSeedsFromStore();
			expect(recentSeeds.individualIds.slice(0, 4)).toEqual(['400', '350', '250', '100']);
			expect(recentSeeds.firmIds.slice(0, 4)).toEqual(['99', '88', '20', '12']);
		});
	});
});
