import { describe, expect, it } from 'vitest';
import { summarizeRecordDetail } from '../../src/components/RecordDashboard';

describe('summarizeRecordDetail', () => {
	it('builds a compact individual summary from the detail payload', () => {
		const summary = summarizeRecordDetail(
			{
				name: 'Alice Johnson',
				basicInformation: { crdNumber: '8276416' },
				currentEmployment: [{ firmName: 'Example Advisory' }],
				employmentHistory: [{ firmName: 'Example Advisory' }],
			},
			'individual',
			'8276416',
		);

		expect(summary.title).toBe('Alice Johnson');
		expect(summary.subtitle).toContain('8276416');
		expect(summary.keyFacts).toContainEqual(expect.objectContaining({ label: 'Current employer', value: 'Example Advisory' }));
	});
});
