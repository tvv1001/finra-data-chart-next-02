import { describe, expect, it } from 'vitest';

import { buildPrimedBundleInventoryTotals, extractCardSummaryFields, summarizeFetchResults } from '../../src/app/api/dashboard/refresh/route';
import { computeQueryFetchCounts, computeQuerySaveStats, describeQuerySaveChange, parseDashboardSelectionFromUrl } from '../../src/app/dashboard/page';

describe('parseDashboardSelectionFromUrl', () => {
	it('reads an individual SEC selection from dashboard query params', () => {
		expect(parseDashboardSelectionFromUrl('https://example.com/dashboard?source=sec&CRD_individual=6655996&sec=1')).toEqual({
			entity: 'individual',
			id: '6655996',
			source: 'sec',
			availableSources: ['sec'],
		});
	});

	it('preserves both source flags for a shared dashboard link', () => {
		expect(parseDashboardSelectionFromUrl('https://example.com/dashboard?source=sec&CRD_individual=6655996&sec=1&finra=1')).toEqual({
			entity: 'individual',
			id: '6655996',
			source: 'sec',
			availableSources: ['finra', 'sec'],
		});
	});
});

describe('buildPrimedBundleInventoryTotals', () => {
	it('does not double-count the same people or firms across FINRA and SEC primed bundles', () => {
		const totals = buildPrimedBundleInventoryTotals([
			{ bundleName: 'finra-individual', recordCount: 10 },
			{ bundleName: 'sec-individual', recordCount: 8 },
			{ bundleName: 'finra-firm', recordCount: 6 },
			{ bundleName: 'sec-firm', recordCount: 4 },
		]);

		expect(totals.people).toBe(10);
		expect(totals.firms).toBe(6);
		expect(totals.unique).toBe(16);
	});
});

describe('computeQueryFetchCounts', () => {
	it('counts how many fetches were added for each query', () => {
		const resolution = [
			{ query: 'alpha', crds: ['100', '101'] },
			{ query: 'beta', crds: ['200'] },
		];
		const fetchedItems = [
			{ crd: '100', status: 'ok' },
			{ crd: '100', status: 'ok' },
			{ crd: '200', status: 'ok' },
			{ crd: '999', status: 'ok' },
		];

		expect(computeQueryFetchCounts(resolution, fetchedItems)).toEqual({
			alpha: 2,
			beta: 1,
		});
	});
});

describe('computeQuerySaveStats', () => {
	it('counts newly saved records and source saves per query', () => {
		const resolution = [
			{ query: 'alpha', crds: ['100', '101'] },
			{ query: 'beta', crds: ['200'] },
		];
		const fetchedItems = [
			{ crd: '100', type: 'individual', status: 'ok', cardKey: 'individual:100', newSourceSaved: true, newRecordSaved: true },
			{ crd: '100', type: 'individual', status: 'ok', cardKey: 'individual:100', newSourceSaved: true, newRecordSaved: false },
			{ crd: '101', type: 'firm', status: 'error', cardKey: 'firm:101', newSourceSaved: false, newRecordSaved: false },
			{ crd: '200', type: 'individual', status: 'ok', cardKey: 'individual:200', newSourceSaved: false, newRecordSaved: false },
		];

		expect(computeQuerySaveStats(resolution, fetchedItems)).toEqual({
			alpha: {
				fetchedCount: 2,
				savedSourceCount: 2,
				savedRecordCount: 1,
				updatedExistingSourceCount: 1,
				updatedExistingRecordCount: 1,
				errorCount: 1,
			},
			beta: {
				fetchedCount: 1,
				savedSourceCount: 0,
				savedRecordCount: 0,
				updatedExistingSourceCount: 0,
				updatedExistingRecordCount: 0,
				errorCount: 0,
			},
		});
	});
});

describe('describeQuerySaveChange', () => {
	it('describes mixed new and existing-record source growth', () => {
		expect(
			describeQuerySaveChange({
				savedRecordCount: 11,
				updatedExistingRecordCount: 1,
				updatedExistingSourceCount: 1,
			}),
		).toBe('11 new CRDs • 1 existing CRD gained 1 new source');
	});

	it('describes pure existing-record source expansion', () => {
		expect(
			describeQuerySaveChange({
				savedRecordCount: 0,
				updatedExistingRecordCount: 2,
				updatedExistingSourceCount: 3,
			}),
		).toBe('2 existing CRDs gained 3 new sources');
	});

	it('describes no newly saved data', () => {
		expect(describeQuerySaveChange({ savedRecordCount: 0, updatedExistingRecordCount: 0, updatedExistingSourceCount: 0 })).toBe('no new data saved');
	});
});

describe('summarizeFetchResults', () => {
	it('reports actual new source and unique record counts separately', () => {
		const summary = summarizeFetchResults([
			{
				crd: '100',
				source: 'finra',
				type: 'individual',
				url: '',
				cacheFile: '',
				redisKey: '',
				status: 'ok',
				redisWrite: 'written',
				cardKey: 'individual:100',
				newSourceSaved: true,
				newRecordSaved: true,
			},
			{
				crd: '100',
				source: 'sec',
				type: 'individual',
				url: '',
				cacheFile: '',
				redisKey: '',
				status: 'ok',
				redisWrite: 'written',
				cardKey: 'individual:100',
				newSourceSaved: true,
				newRecordSaved: false,
			},
			{
				crd: '200',
				source: 'finra',
				type: 'firm',
				url: '',
				cacheFile: '',
				redisKey: '',
				status: 'error',
				redisWrite: 'error',
				cardKey: 'firm:200',
				newSourceSaved: false,
				newRecordSaved: false,
			},
		]);

		expect(summary).toEqual({
			crdCount: 2,
			requests: 3,
			successCount: 2,
			errorCount: 1,
			newSourceCount: 2,
			newRecordCount: 1,
			newPeopleCount: 1,
			newFirmCount: 0,
		});
	});
});

describe('extractCardSummaryFields', () => {
	it('prefers concise, explicit metadata over deep nested JSON-like values', () => {
		const summary = extractCardSummaryFields(
			{
				basicInformation: {
					name: 'Jane Doe',
					bcScope: 'active',
					iaScope: 'inactive',
				},
				memberSince: '2020-01-01',
				registrationDate: '2024-09-15',
				details: {
					startDate: '1999-01-01',
					raw: '{"memberSince":"2024-06-01"}',
				},
			},
			'12345',
		);

		expect(summary.name).toBe('Jane Doe');
		expect(summary.memberSince).toBe('2020-01-01');
		expect(summary.statusText).toContain('FINRA Active');
		expect(summary.statusText).toContain('SEC Inactive');
	});

	it('keeps status text scoped to the selected source when a source hint is provided', () => {
		const summary = extractCardSummaryFields(
			{
				basicInformation: {
					name: 'Jane Doe',
					bcScope: 'active',
					iaScope: 'inactive',
				},
			},
			'12345',
			'finra',
		);

		expect(summary.statusText).toBe('FINRA Active');
		expect(summary.statusText).not.toContain('SEC');
	});
});
