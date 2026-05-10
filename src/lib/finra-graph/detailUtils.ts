import { normalizePersonLabel } from './formatters';

function isPlaceholderNodeLabel(label, group) {
	const text = String(label || '').trim();
	if (!text) return true;
	if (/^\d+$/.test(text)) return true;
	if (/^(?:crd|sec)#?\s*\d+$/i.test(text)) return true;
	if (group === 'individual') {
		return /^CRD\s+\d+$/i.test(text) || /^Person\s+\d+$/i.test(text);
	}
	if (group === 'firm') {
		return /^Firm\s+\d+$/i.test(text);
	}
	return false;
}

export function flattenEmploymentRecords(detail, { includeGeneric = false }: { includeGeneric?: boolean } = {}) {
	return [
		...(detail?.currentEmployments || []).map((employment) => ({ ...employment, _isCurrent: true })),
		...(detail?.currentIAEmployments || []).map((employment) => ({ ...employment, _isCurrent: true })),
		...(detail?.previousEmployments || []).map((employment) => ({ ...employment, _isCurrent: false })),
		...(detail?.previousIAEmployments || []).map((employment) => ({ ...employment, _isCurrent: false })),
		...(includeGeneric ? detail?.employments || [] : []),
	];
}

export function normalizeFirmLabelKey(label) {
	return String(label || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

export function buildSyntheticFirmNodeId(label) {
	const normalized = String(label || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized ? `firm:name:${normalized}` : null;
}

export function findExistingPersonNode(crd, layoutNodes) {
	const value = String(crd || '').trim();
	if (!value) return null;
	return layoutNodes?.find((node) => node.group === 'individual' && (node.id === `person:${value}` || node.id === `person_${value}` || String(node.crd || '') === value)) || null;
}

export function findFirmNodeByLabel(label, layoutNodes) {
	const normalizedLabel = normalizeFirmLabelKey(label);
	if (!normalizedLabel) return null;
	return layoutNodes?.find((node) => node.group === 'firm' && normalizeFirmLabelKey(node.label) === normalizedLabel) || null;
}

export function findExistingFirmNode(firmId, layoutNodes, { label = '' }: { label?: string } = {}) {
	const value = String(firmId || '').trim();
	if (value) {
		const existingById =
			layoutNodes?.find(
				(node) =>
					node.group === 'firm' &&
					(node.id === `firm:${value}` ||
						node.id === `firm_${value}` ||
						String(node.firmId || '') === value ||
						String(node.bdSecNumber || '') === value ||
						String(node.iaSecNumber || '') === value),
			) || null;
		if (existingById) return existingById;
	}
	return findFirmNodeByLabel(label, layoutNodes);
}

export function applyIndividualDetail(targetNode, detail, fallbackCrd = null) {
	if (!targetNode || !detail) return targetNode;

	const bi = detail?.basicInformation || {};
	targetNode.basicInformation = bi;

	if (bi.individualId || fallbackCrd) {
		targetNode.crd = String(bi.individualId || fallbackCrd);
	}
	if (bi.bcScope) targetNode.bcScope = bi.bcScope;
	if (bi.iaScope) targetNode.iaScope = bi.iaScope;
	if (detail.hasSecData != null) targetNode.hasSecData = detail.hasSecData;
	if (detail.hasFinraData != null) targetNode.hasFinraData = detail.hasFinraData;

	const fullName = [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ');
	const preferredName = normalizePersonLabel(fullName || bi.name || detail?.name || '');
	if (preferredName && (isPlaceholderNodeLabel(targetNode.label, 'individual') || preferredName.length > String(targetNode.label || '').length)) {
		targetNode.label = preferredName;
	}
	if (Array.isArray(bi.otherNames)) targetNode.otherNames = bi.otherNames;

	if (Array.isArray(detail.currentEmployments)) {
		targetNode.currentEmployments = detail.currentEmployments;
	}
	if (Array.isArray(detail.previousEmployments)) {
		targetNode.previousEmployments = detail.previousEmployments;
	}
	if (Array.isArray(detail.currentIAEmployments)) {
		targetNode.currentIAEmployments = detail.currentIAEmployments;
	}
	if (Array.isArray(detail.previousIAEmployments)) {
		targetNode.previousIAEmployments = detail.previousIAEmployments;
	}

	if (Array.isArray(detail.disclosures)) {
		targetNode.disclosures = detail.disclosures;
	}
	if (Array.isArray(detail.iaDisclosures)) {
		targetNode.iaDisclosures = detail.iaDisclosures;
	}
	if (bi.disclosureFlag) targetNode.disclosureFlag = bi.disclosureFlag;
	if (detail.disclosureFlag) targetNode.disclosureFlag = detail.disclosureFlag;
	if (detail.iaDisclosureFlag) {
		targetNode.iaDisclosureFlag = detail.iaDisclosureFlag;
	}

	if (detail.examsCount) targetNode.examsCount = detail.examsCount;
	if (Array.isArray(detail.stateExamCategory)) {
		targetNode.stateExamCategory = detail.stateExamCategory;
	}
	if (Array.isArray(detail.principalExamCategory)) {
		targetNode.principalExamCategory = detail.principalExamCategory;
	}
	if (Array.isArray(detail.productExamCategory)) {
		targetNode.productExamCategory = detail.productExamCategory;
	}

	if (Array.isArray(detail.registeredSROs)) {
		targetNode.registeredSROs = detail.registeredSROs;
	}
	if (Array.isArray(detail.registeredStates)) {
		targetNode.registeredStates = detail.registeredStates;
	}
	if (detail.registrationCount) {
		targetNode.registrationCount = detail.registrationCount;
	}
	if (detail.brokerDetails) targetNode.brokerDetails = detail.brokerDetails;

	try {
		const firms = new Set();
		for (const employment of flattenEmploymentRecords(detail)) {
			if (employment?.firmId) firms.add(employment.firmId);
			else if (employment?.bdSECNumber) firms.add(employment.bdSECNumber);
		}
		targetNode.firmCount = firms.size;
	} catch {
		/* ignore */
	}

	try {
		if (bi.daysInIndustry) {
			targetNode.daysInIndustry = Number(bi.daysInIndustry);
			targetNode.yearsExperience = Math.floor(targetNode.daysInIndustry / 365);
		} else if (bi.daysInIndustryCalculatedDate || bi.daysInIndustryCalculatedDateIAPD) {
			const dstr = bi.daysInIndustryCalculatedDate || bi.daysInIndustryCalculatedDateIAPD;
			const year = new Date(dstr).getFullYear();
			if (year && !Number.isNaN(year)) {
				targetNode.yearsExperience = Math.max(0, new Date().getFullYear() - year);
			}
		}
	} catch {
		/* ignore */
	}

	try {
		const current = detail.currentEmployments?.[0] || detail.currentIAEmployments?.[0];
		if (current) {
			const office = current.branchOfficeLocations?.[0];
			const parts = office ? [office.street1, office.street2, office.city, office.state, office.zipCode].filter(Boolean) : [];
			targetNode.primaryOffice = {
				firmId: current.firmId,
				firmName: current.firmName,
				address: parts.join(', '),
			};
		}
	} catch {
		/* ignore */
	}

	targetNode._detailLoaded = true;
	return targetNode;
}

export function getEmploymentRelationship(entry) {
	return entry && entry._isCurrent === false ? 'previous_employed_by' : 'employed_by';
}

export function normalizeIndividualDetailPayload(detail, fallbackCrd) {
	if (!detail || typeof detail !== 'object') return detail;
	if (!detail.basicInformation) {
		const bi: Record<string, any> = {};
		if (detail.individualId || detail.ind_source_id || detail.crd || fallbackCrd) {
			bi.individualId = detail.individualId || detail.ind_source_id || detail.crd || fallbackCrd;
		}
		if (detail.firstName) bi.firstName = detail.firstName;
		if (detail.middleName) bi.middleName = detail.middleName;
		if (detail.lastName) bi.lastName = detail.lastName;
		if (detail.name) bi.name = detail.name;
		if (detail.bcScope) bi.bcScope = detail.bcScope;
		if (detail.iaScope) bi.iaScope = detail.iaScope;
		if (detail.otherNames) bi.otherNames = detail.otherNames;
		if (Object.keys(bi).length) {
			detail.basicInformation = bi;
		}
	}
	return detail;
}

export function hasRichIndividualDetail(detail) {
	if (!detail || typeof detail !== 'object') return false;
	const listFields = [
		'currentEmployments',
		'previousEmployments',
		'currentIAEmployments',
		'previousIAEmployments',
		'disclosures',
		'iaDisclosures',
		'registeredStates',
		'registeredSROs',
	];
	for (const key of listFields) {
		if (Array.isArray(detail[key]) && detail[key].length) return true;
	}
	if (detail.registrationCount || detail.examsCount || detail.brokerDetails) return true;
	return false;
}

export function normalizeComparableName(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export { normalizePersonLabel };
