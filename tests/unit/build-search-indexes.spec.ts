import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'build_search_indexes.js');

async function withTempRepo(run: (root: string) => void | Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'finra-build-search-indexes-'));
	await mkdir(path.join(root, 'data', 'national'), { recursive: true });
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe('build_search_indexes script', () => {
	it('keeps missing local search indexes non-fatal when Redis fallback is configured', async () => {
		await withTempRepo(async (root) => {
			const result = spawnSync(process.execPath, [scriptPath], {
				cwd: root,
				env: {
					...process.env,
					UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
					UPSTASH_REDIS_REST_TOKEN: 'test-token',
				},
				encoding: 'utf8',
			});

			expect(result.status).toBe(0);
			expect(result.stderr).toContain('runtime search can fall back to Redis');
			expect(result.stderr).not.toContain('Missing finra:individual search index output');
		});
	});
});
