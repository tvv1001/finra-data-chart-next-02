import { describe, expect, it } from 'vitest';

import { buildPrimedBundleInventoryTotals, extractCardSummaryFields } from '../../src/app/api/dashboard/refresh/route';
import { computeQueryFetchCounts, parseDashboardSelectionFromUrl } from '../../src/app/dashboard/page';

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
