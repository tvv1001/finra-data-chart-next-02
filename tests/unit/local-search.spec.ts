import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { searchLocalIndex } from '@/lib/localSearch';
import { getSearchIndexFilePath } from '@/lib/searchDataPaths';

async function withTempSearchIndex(fileName: string, content: string | Buffer, run: (root: string) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'finra-search-index-'));
	const indexDir = path.join(root, 'data', 'national');
	await mkdir(indexDir, { recursive: true });
	await writeFile(path.join(indexDir, fileName), content);
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe('local search indexes', () => {
	it('returns FINRA individual results from the local index', async () => {
		const result = await searchLocalIndex('finra', 'individual', 'paula branum', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.hits.length).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1000475');
		expect(String(result.response.docs[0]?.ind_lastname || '').toLowerCase()).toContain('branum');
	});

	it('returns SEC firm results from the local index', async () => {
		const result = await searchLocalIndex('sec', 'firm', '39914', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.hits.length).toBeGreaterThan(0);
		expect(result.response.docs[0]?.firm_id).toBe('39914');
		expect(String(result.response.docs[0]?.firm_name || '').toLowerCase()).toContain('westpark');
	});

	it('supports fuzzy matching on individual names', async () => {
		const result = await searchLocalIndex('finra', 'individual', 'ray bacala', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1000495');
		expect(String(result.response.docs[0]?.ind_lastname || '').toLowerCase()).toContain('baccala');
	});

	it('matches Mason as a whole word in first, middle, or last name', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.total).toBeLessThan(5000);
		expect(result.response.docs[0]?.ind_source_id).toBe('1222513');
		expect(result.response.docs.some((doc) => String(doc.ind_source_id || '') === '1222513')).toBe(true);
		expect(result.response.docs.some((doc) => String(doc.ind_source_id || '') === '1098656')).toBe(true);
	});

	it('matches the top-level full name when queried directly', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'ronald noel mason', { limit: 10 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1222513');
		expect(String(result.response.docs[0]?.ind_firstname || '').toUpperCase()).toBe('RONALD');
		expect(String(result.response.docs[0]?.ind_lastname || '').toUpperCase()).toBe('MASON');
	});

	it('includes firms whose alias names contain Mason', async () => {
		const result = await searchLocalIndex('sec', 'firm', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs.some((doc) => String(doc.firm_id || '') === '39914')).toBe(true);
		expect(
			result.response.docs.some((doc) => {
				const aliases = [doc.otherNames, doc.firm_other_names, doc.previousNames, doc.previous_names].flat().filter(Boolean) as string[];
				return aliases.some((alias) => /\bmason\b/i.test(String(alias)));
			}),
		).toBe(true);
	});

	it('includes individuals whose alias or previous names contain Mason', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs.some((doc) => String(doc.ind_source_id || '') === '1222513')).toBe(true);
		expect(
			result.response.docs.some((doc) => {
				const aliases = [doc.otherNames, doc.ind_other_names, doc.previousNames, doc.previous_names].flat().filter(Boolean) as string[];
				return aliases.some((alias) => /\bmason\b/i.test(String(alias)));
			}),
		).toBe(true);
	});

	it('matches past names and aliases for individuals', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'lisa keverian', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1001173');
		expect(result.response.docs[0]?.otherNames).toContain('LISA ANN KEVERIAN');
	});

	it('resolves search index files from nested runtime roots', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json',
			JSON.stringify({ generatedAt: '2026-06-06T00:00:00.000Z', bucket: 'finra:individual', docs: [] }),
			async (root) => {
				const resolvedPath = getSearchIndexFilePath('finra:individual', [path.join(root, 'src', 'lib')]);
				expect(resolvedPath).toBe(path.join(root, 'data', 'national', 'search-index.finra.individual.json'));
			},
		);
	});

	it('prefers gzip search indexes when they are available', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json.gz',
			gzipSync(
				Buffer.from(
					JSON.stringify({
						generatedAt: '2026-06-06T00:00:00.000Z',
						bucket: 'finra:individual',
						docs: [],
					}),
				),
			),
			async (root) => {
				const resolvedPath = getSearchIndexFilePath('finra:individual', [root]);
				expect(resolvedPath).toBe(path.join(root, 'data', 'national', 'search-index.finra.individual.json.gz'));
			},
		);
	});

	it('falls back to plain JSON search indexes when gzip is unavailable', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json',
			JSON.stringify({ generatedAt: '2026-06-06T00:00:00.000Z', bucket: 'finra:individual', docs: [] }),
			async (root) => {
				const resolvedPath = getSearchIndexFilePath('finra:individual', [root]);
				expect(resolvedPath).toBe(path.join(root, 'data', 'national', 'search-index.finra.individual.json'));
			},
		);
	});
});
