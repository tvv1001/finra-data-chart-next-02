import { describe, expect, it } from 'vitest';
import { __localSearchInternals } from '@/lib/localSearch';

describe('local search fuzzy matching', () => {
	const docs = [
		__localSearchInternals.prepareDoc({
			id: 'finra:firm:17530',
			type: 'firm',
			source: 'finra',
			searchText: '17530 BOK FINANCIAL SECURITIES INC INACTIVE 35766',
			hit: { firm_id: '17530', firm_name: 'BOK FINANCIAL SECURITIES, INC.' },
		}),
		__localSearchInternals.prepareDoc({
			id: 'finra:firm:23407',
			type: 'firm',
			source: 'finra',
			searchText: '23407 BUCKMAN BUCKMAN REID INC INACTIVE',
			hit: { firm_id: '23407', firm_name: 'BUCKMAN, BUCKMAN & REID, INC.' },
		}),
		__localSearchInternals.prepareDoc({
			id: 'finra:firm:99999',
			type: 'firm',
			source: 'finra',
			searchText: '99999 VEGA CHI US LIMITED',
			hit: { firm_id: '99999', firm_name: 'VEGA-CHI US LIMITED' },
		}),
	];

	it('matches compacted multi-word queries without requiring spaces', () => {
		const matches = __localSearchInternals.filterExactMatches(['bokfinancial'], docs);

		expect(matches.map((doc) => doc.id)).toEqual(['finra:firm:17530']);
	});

	it('falls back to fuzzy matching when a longer user token contains the indexed token', () => {
		const exactMatches = __localSearchInternals.filterExactMatches(['bokchito'], docs);
		const fuzzyMatches = __localSearchInternals.filterFuzzyMatches(['bokchito'], docs);

		expect(exactMatches).toHaveLength(0);
		expect(fuzzyMatches.map((doc) => doc.id)).toContain('finra:firm:17530');
		expect(fuzzyMatches.map((doc) => doc.id)).not.toContain('finra:firm:99999');
	});

	it('supports small typo tolerance for single-token searches', () => {
		const fuzzyMatches = __localSearchInternals.filterFuzzyMatches(['buckamn'], docs);

		expect(fuzzyMatches.map((doc) => doc.id)).toContain('finra:firm:23407');
	});

	it('collects otherNames from top-level and basicInformation payload fields', () => {
		const aliases = __localSearchInternals.collectOtherNames(
			{
				otherNames: ['Alpha Partners'],
				other_names: ['Alpha Legacy'],
			},
			{
				otherNames: ['Alpha Partners', 'Alpha Capital'],
			},
		);

		expect(aliases).toEqual(['Alpha Partners', 'Alpha Legacy', 'Alpha Capital']);
	});
});
