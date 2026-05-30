// Normalizers for FINRA/SEC payloads used by build and verification scripts
function normalizeEmploymentRecord(e) {
	if (!e || typeof e !== 'object') return null;
	const branch =
		Array.isArray(e.branchOfficeLocations) && e.branchOfficeLocations.length ? e.branchOfficeLocations[0] : (e.branch_office_locations && e.branch_office_locations[0]) || {};
	const firm_bd_sec_number = String(e.bdSECNumber || e.bd_sec_number || e.bdSecNumber || e.firm_bd_sec_number || '').trim() || undefined;
	const normalized = {
		firm_id: e.firmId || e.firm_id ? String(e.firmId || e.firm_id) : undefined,
		firm_name: e.firmName || e.firm_name || undefined,
		branch_city: branch.city || branch.city || undefined,
		branch_state: branch.state || undefined,
		branch_zip: branch.zipCode || branch.zipCode || branch.zip_code || branch.zip || undefined,
		ia_only: e.iaOnly || e.ia_only || undefined,
		firm_bd_sec_number: firm_bd_sec_number,
	};
	if (normalized.firm_bd_sec_number && !normalized.firm_bd_full_sec_number) normalized.firm_bd_full_sec_number = `8-${normalized.firm_bd_sec_number}`;
	return Object.fromEntries(Object.entries(normalized).filter(([k, v]) => v !== undefined));
}

function normalizeIndividualPayload(c) {
	if (!c || typeof c !== 'object') return {};
	const basic = c.basicInformation || c.basic_information || {};
	const currentEmps =
		Array.isArray(c.currentEmployments) ? c.currentEmployments
		: Array.isArray(c.ind_current_employments) ? c.ind_current_employments
		: [];
	const previousEmps =
		Array.isArray(c.previousEmployments) ? c.previousEmployments
		: Array.isArray(c.ind_previous_employments) ? c.ind_previous_employments
		: [];
	const mappedCurrent = currentEmps.map(normalizeEmploymentRecord).filter(Boolean);
	const mappedPrevious = previousEmps.map(normalizeEmploymentRecord).filter(Boolean);
	return {
		basicInformation: {
			firstName: basic.firstName || basic.name || null,
			middleName: basic.middleName || null,
			lastName: basic.lastName || null,
			displayName: basic.firstName || basic.lastName ? `${(basic.firstName || '').trim()} ${(basic.lastName || '').trim()}`.trim() : basic.name || null,
		},
		currentEmployments: mappedCurrent,
		previousEmployments: mappedPrevious,
	};
}

module.exports = {
	normalizeEmploymentRecord,
	normalizeIndividualPayload,
};
