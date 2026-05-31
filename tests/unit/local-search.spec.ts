import { describe, expect, it } from 'vitest';
import { searchLocalIndex } from '@/lib/localSearch';

describe('local search indexes', () => {
	it('returns FINRA individual results from the local index', async () => {
		const result = await searchLocalIndex('finra', 'individual', 'paula branum', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.hits.length).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1000475');
		expect(String(result.response.docs[0]?.ind_lastname || '').toLowerCase()).toContain('branum');
	});

	it('returns SEC firm results from the local index', async () => {
		const result = await searchLocalIndex('sec', 'firm', 'advest', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.hits.length).toBeGreaterThan(0);
		expect(result.response.docs[0]?.firm_id).toBe('10');
		expect(String(result.response.docs[0]?.firm_name || '').toLowerCase()).toContain('advest');
	});

	it('supports fuzzy matching on individual names', async () => {
		const result = await searchLocalIndex('finra', 'individual', 'ray bacala', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1000495');
		expect(String(result.response.docs[0]?.ind_lastname || '').toLowerCase()).toContain('baccala');
	});

	it('matches past names and aliases for individuals', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'lisa keverian', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1001173');
		expect(result.response.docs[0]?.otherNames).toContain('LISA ANN KEVERIAN');
	});
});
