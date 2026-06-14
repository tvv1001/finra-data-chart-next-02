import { describe, expect, it } from 'vitest';

import { extractCardSummaryFields } from '../../src/app/api/dashboard/refresh/route';

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
