import { describe, it, expect } from 'vitest';
const { normalizeEmploymentRecord, normalizeIndividualPayload } = require('../../../scripts/normalizers/finra-normalize');

describe('FINRA normalizers', () => {
	it('normalizeEmploymentRecord maps common fields', () => {
		const raw = {
			firmId: 330920,
			firmName: 'COGENT ASSOCIATES, LLC',
			bdSECNumber: '71253',
			branchOfficeLocations: [{ city: 'WOODSTOCK', state: 'VT', zipCode: '05091' }],
			iaOnly: 'N',
		};
		const out = normalizeEmploymentRecord(raw);
		expect(out).toEqual(
			expect.objectContaining({
				firm_id: '330920',
				firm_name: 'COGENT ASSOCIATES, LLC',
				branch_city: 'WOODSTOCK',
				branch_state: 'VT',
				branch_zip: '05091',
				ia_only: 'N',
				firm_bd_sec_number: '71253',
				firm_bd_full_sec_number: '8-71253',
			}),
		);
	});

	it('normalizeIndividualPayload maps basicInformation and employments', () => {
		const raw = {
			basicInformation: { firstName: 'Daniel', lastName: 'Beaton' },
			currentEmployments: [
				{ firmId: 330920, firmName: 'COGENT ASSOCIATES, LLC', bdSECNumber: '71253', branchOfficeLocations: [{ city: 'WOODSTOCK', state: 'VT', zipCode: '05091' }] },
			],
		};
		const out = normalizeIndividualPayload(raw);
		expect(out.basicInformation.displayName).toBe('Daniel Beaton');
		expect(Array.isArray(out.currentEmployments)).toBe(true);
		expect(out.currentEmployments[0]).toHaveProperty('firm_id', '330920');
	});
});
