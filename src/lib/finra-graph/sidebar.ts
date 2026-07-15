/* eslint-disable @typescript-eslint/no-explicit-any */
import { capitalize, esc, firmSizeLabel, formatLocationText, formatUiText, normalizePersonLabel, row } from './formatters';
import { buildParentFirmSummaryLinks } from './externalLinks';

type RenderContext = {
	graphData?: any;
};

function hasAnyItems(list: any[] | null | undefined) {
	return Array.isArray(list) && list.length > 0;
}

function hasPublicFinraIndividualPage(detail: any, basicInformation: Record<string, any> = {}) {
	const bcScope = String(detail?.bcScope || basicInformation?.bcScope || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (bcScope === 'notinscope') return false;
	if (bcScope && bcScope !== 'notinscope') return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedFinraRegistrationCount || 0) > 0) return true;
	if (Number(registrationCount.approvedSRORegistrationCount || 0) > 0) return true;
	if (hasAnyItems(detail?.registeredSROs)) return true;

	return false;
}

function hasPublicSecIndividualPage(detail: any, basicInformation: Record<string, any> = {}) {
	const iaScope = String(detail?.iaScope || basicInformation?.iaScope || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (iaScope && iaScope !== 'notinscope') return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (hasAnyItems(detail?.currentIAEmployments)) return true;
	if (hasAnyItems(detail?.previousIAEmployments)) return true;
	if (hasAnyItems(detail?.iaDisclosures)) return true;
	if (
		Array.isArray(detail?.registeredStates) &&
		detail.registeredStates.some(
			(entry: any) =>
				String(entry?.regScope || '')
					.trim()
					.toLowerCase() === 'ia',
		)
	) {
		return true;
	}

	return false;
}

type NodeSourceCoverage = 'both' | 'sec_only' | 'finra_only' | 'none';

function toNodeSourceCoverage(finra: boolean, sec: boolean): NodeSourceCoverage {
	if (finra && sec) return 'both';
	if (sec) return 'sec_only';
	if (finra) return 'finra_only';
	return 'none';
}

// Firms known to have broken or unreachable FINRA/BrokerCheck summary pages.
// Add CRD numbers here to suppress FINRA links for those firms.
const BROKEN_FINRA_FIRM_IDS = new Set(['134139', '298880', '314694', '325639']);

// Individual IDs for which SEC AdvisorInfo links should be suppressed.
// Add numeric individual CRD-like ids (no prefix) here when upstream SEC pages are incorrect or undesirable.
const SUPPRESSED_SEC_INDIV_IDS = new Set(['18040']);
// Firm IDs for which SEC AdvisorInfo links should be suppressed.
// Add numeric firm CRD-like ids (no prefix) here when upstream SEC pages are unavailable or incorrect.
const SUPPRESSED_SEC_FIRM_IDS = new Set(['4039']);

function isNotInScopeValue(value) {
	return (
		String(value || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '') === 'notinscope'
	);
}

function hasIndividualFinraPresence(node) {
	if (!node || typeof node !== 'object') return false;
	// Per-node suppression: if the node explicitly suppresses FINRA links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'finra',
		)
	)
		return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	if (node.hasFinraData === true) return true;
	if (hasPublicFinraIndividualPage(node, node.basicInformation || {})) return true;
	if (hasAnyItems(node?.currentEmployments)) return true;
	if (hasAnyItems(node?.previousEmployments)) return true;
	return false;
}

function hasIndividualSecPresence(node) {
	if (!node || typeof node !== 'object') return false;

	// Per-node suppression: if the node explicitly suppresses SEC links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'sec',
		)
	)
		return false;

	// Per-id suppression: if the node's id/crd is known to be invalid for SEC links, suppress.
	const rawId = String(node?.crd || node?.basicInformation?.individualId || node?.individualId || node?.id || '')
		.replace(/^person[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawId && SUPPRESSED_SEC_INDIV_IDS.has(rawId)) return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	if (node.hasSecData === true) return true;
	if (hasPublicSecIndividualPage(node, node.basicInformation || {})) return true;
	if (Number(node?.registrationCount?.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (
		Array.isArray(node?.registeredStates) &&
		node.registeredStates.some((entry) => {
			if (!entry || typeof entry !== 'object') return false;
			const scope = String(entry.regScope || entry.scope || '')
				.trim()
				.toLowerCase();
			return scope === 'ia';
		})
	) {
		return true;
	}
	if (hasAnyItems(node?.previousIAEmployments)) return true;
	if (hasAnyItems(node?.iaDisclosures)) return true;
	return false;
}

function hasFirmFinraPresence(node: any) {
	if (!node || typeof node !== 'object') return false;

	// Per-node suppression: if the node explicitly suppresses FINRA links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'finra',
		)
	)
		return false;

	// if this firm is explicitly blacklisted, treat as no FINRA presence
	const rawFirmId = String(node?.firmId || node?.id || '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawFirmId && BROKEN_FINRA_FIRM_IDS.has(rawFirmId)) return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	if (node.hasFinraData === true) return true;
	if (node.isLegacy === 'Y') return true;
	// If this firm carries a SEC '8-' identifier and we don't have explicit FINRA data,
	// treat it as SEC-only and do not surface a FINRA brokercheck link.
	const secIdRaw = node?.iaSecNumber || node?.basicInformation?.iaSECNumber || node?.basicInformation?.bdSECNumber || node?.bdSECNumber || '';
	const secId = String(secIdRaw || '').trim();
	if (secId && /^8-\d+/i.test(secId)) return false;

	if (Boolean(String(node?.bcScope || node?.basicInformation?.bcScope || '').trim())) return true;
	return false;
}

function hasFirmSecPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'sec',
		)
	)
		return false;
	const rawFirmId = String(node?.firmId || node?.id || '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawFirmId && SUPPRESSED_SEC_FIRM_IDS.has(rawFirmId)) return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	if (node.hasSecData === true) return true;
	if (Boolean(String(node?.iaSecNumber || node?.basicInformation?.iaSECNumber || node?.basicInformation?.iaSecNumber || '').trim())) return true;
	if (hasAnyItems(node?.secDocumentLinks)) return true;
	if (Boolean(String(node?.secSummaryDescription || '').trim())) return true;
	return false;
}

function formatNodeSourceTruthSummary(node: any) {
	const finra = node?.group === 'firm' ? hasFirmFinraPresence(node) : hasIndividualFinraPresence(node);
	const sec = node?.group === 'firm' ? hasFirmSecPresence(node) : hasIndividualSecPresence(node);
	const coverage = toNodeSourceCoverage(finra, sec);
	const coverageLabel =
		coverage === 'both' ? 'both SEC+FINRA'
		: coverage === 'sec_only' ? 'SEC only'
		: coverage === 'finra_only' ? 'FINRA only'
		: 'none';
	return `FINRA=${finra ? 'true' : 'false'} · SEC=${sec ? 'true' : 'false'} (${coverageLabel})`;
}

export function renderPersonDetail(d: any, context: RenderContext = {}) {
	const graphData = context.graphData;
	const bi = d.basicInformation || {};
	const hasFinraPage = hasIndividualFinraPresence(d);
	const hasSecPage = hasIndividualSecPresence(d);
	const links: any[] = (graphData?.links || []).filter((l: any) => (l.source?.id || l.source) === d.id || (l.target?.id || l.target) === d.id);
	const controlLinks = links.filter((l: any) => l.relationship === 'controls');

	const stubBadge = d.stub ? `<span class='fg-badge stub'>Form BD stub</span>` : '';

	function formatDomainScopeBadge(text: string | null | undefined, domain: string, sourceTitle: string) {
		const raw = String(text || '').trim();
		if (!raw) return '';
		const normalized = raw.toLowerCase().replace(/\s+/g, '');
		const isActive = /active|approved/.test(normalized) && !/inactive|notinscope|terminated|revoked|suspended/.test(normalized);
		const label = `${isActive ? 'Active' : 'Inactive'} ${domain}`;
		return `<span class='fg-badge ${isActive ? 'active' : 'inactive'}' title='${esc(sourceTitle)}'>${esc(label)}</span>`;
	}

	const finraScopeText = d.bcScope || bi.bcScope || (hasFinraPage ? 'Active' : '');
	const secScopeText = d.iaScope || bi.iaScope || (hasSecPage ? 'Active' : '');
	const scopeBadgesHtml = [formatDomainScopeBadge(finraScopeText, 'finra', 'FINRA'), formatDomainScopeBadge(secScopeText, 'sec', 'SEC AdvisorInfo')].filter(Boolean).join(' ');

	const rawDisclosures = [
		...(d.disclosures || []).map((dis) => ({ ...dis, _sourceLabel: dis?._sourceLabel || 'FINRA' })),
		...(d.iaDisclosures || []).map((dis) => ({ ...dis, _sourceLabel: dis?._sourceLabel || 'SEC AdvisorInfo' })),
	];
	const allDisclosures = (() => {
		function normalizeTypeForKey(val: any) {
			return String(val || '')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, ' ')
				.trim();
		}

		function disHasContent(dis: any) {
			return !!(
				(dis.eventDate || dis.date || '').trim() ||
				(dis.disclosureResolution || dis.resolution || '').trim() ||
				(dis.disclosureDetail && Object.keys(dis.disclosureDetail).length > 0)
			);
		}

		const byType = new Map();
		for (const dis of rawDisclosures) {
			const dtype = normalizeTypeForKey(dis.disclosureType || dis.type || '');
			if (!byType.has(dtype)) byType.set(dtype, false);
			if (disHasContent(dis)) byType.set(dtype, true);
		}

		const seen = new Map();
		for (const dis of rawDisclosures) {
			const dtype = normalizeTypeForKey(dis.disclosureType || dis.type || '');
			const ddate = normalizeDateForKey(dis.eventDate || dis.date || '');
			const key = `${dtype}||${ddate}`;
			const hasContent = disHasContent(dis);

			if (!hasContent && byType.get(dtype)) continue;

			if (!seen.has(key)) {
				seen.set(key, { ...dis });
			} else {
				const existing = seen.get(key);
				if (existing._sourceLabel && dis._sourceLabel && existing._sourceLabel !== dis._sourceLabel) {
					const sources = new Set([...existing._sourceLabel.split(',').map((s: string) => s.trim()), ...dis._sourceLabel.split(',').map((s: string) => s.trim())]);
					existing._sourceLabel = Array.from(sources).join(', ');
				}
				if (hasContent && !disHasContent(existing)) {
					const mergedLabel = existing._sourceLabel;
					const updated = { ...dis };
					updated._sourceLabel = mergedLabel;
					seen.set(key, updated);
				}
			}
		}
		return Array.from(seen.values()).sort((a, b) => compareCurrentFirstByDates(a, b, { currentKey: '__never', dateKeys: ['eventDate', 'date'] }));
	})();
	const disclosureCount = allDisclosures.length;
	const aliases = (d.otherNames?.length ? d.otherNames : bi.otherNames || []).map((alias) => normalizePersonLabel(alias)).filter(Boolean);

	function empToEntry(emp, isCurrent) {
		const bo = emp.branchOfficeLocations?.[0];
		const city = emp.city || bo?.city || '';
		const state = emp.state || bo?.state || '';
		const street1 = bo?.street1 || '';
		const street2 = bo?.street2 || '';
		const zip = emp.zipCode || bo?.zipCode || '';
		const loc = formatLocationText([city, state].filter(Boolean).join(', '));
		const addr = formatLocationText([street1, street2, city, state, zip].filter(Boolean).join(', '));
		return {
			firmName: emp.firmName || '',
			firmId: emp.firmId,
			bdSecNumber: emp.bdSECNumber,
			iaSECNumber: emp.iaSECNumber,
			start: emp.registrationBeginDate || '',
			end: emp.registrationEndDate || null,
			isCurrent: isCurrent || !emp.registrationEndDate,
			employmentStatus: emp.employmentStatus || emp.status || emp.currentStatus || '',
			iaOnly: emp.iaOnly === 'Y',
			firmBCScope: emp.firmBCScope,
			firmIAScope: emp.firmIAScope,
			loc,
			addr,
			expelledDate: emp.expelledDate,
		};
	}

	function getEmploymentDetailLine(entry) {
		return entry.addr || entry.loc || '';
	}

	function getEmploymentScopeTags(entry) {
		return [
			entry.employmentStatus ? formatUiText(entry.employmentStatus) : null,
			entry.iaOnly ? 'IA only' : null,
			entry.firmBCScope && entry.firmBCScope !== 'ACTIVE' ? `Firm FINRA: ${formatUiText(entry.firmBCScope)}` : null,
		].filter(Boolean);
	}

	function regToEntry(emp, role, isCurrent) {
		const office = emp.branchOfficeLocations?.[0];
		const officeAddress = office ? formatLocationText([office.street1, office.street2, office.city, office.state, office.zipCode].filter(Boolean).join(', ')) : '';
		const cityState = formatLocationText([emp.city || office?.city || '', emp.state || office?.state || ''].filter(Boolean).join(', '));
		return {
			role,
			firmId: emp.firmId,
			firmName: emp.firmName || '',
			start: emp.registrationBeginDate || '',
			end: emp.registrationEndDate || null,
			isCurrent,
			officeAddress,
			cityState,
		};
	}

	function normalizeDateForKey(val: any) {
		const parsed = parseSortDateValue(val);
		return parsed !== Number.NEGATIVE_INFINITY ? new Date(parsed).toISOString().split('T')[0] : String(val).trim().toLowerCase();
	}

	function dedupeRegs(items) {
		const seen = new Set();
		return items.filter((item) => {
			const normStart = item.start ? normalizeDateForKey(item.start) : '';
			const normEnd = item.end ? normalizeDateForKey(item.end) : 'present';
			const key = [
				item.role,
				String(item.firmId || '').trim(),
				normStart,
				normEnd,
				String(item.cityState || '')
					.trim()
					.toLowerCase(),
			].join('|');
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	function parseSortDateValue(value) {
		const raw = String(value || '').trim();
		if (!raw) return Number.NEGATIVE_INFINITY;
		const shortDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
		if (shortDateMatch) {
			const [, month, day, year] = shortDateMatch;
			return Date.UTC(Number(year), Number(month) - 1, Number(day));
		}
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
	}

	function compareCurrentFirstByDates(a, b, options: { currentKey?: string; dateKeys?: string[] } = {}) {
		const currentKey = options.currentKey || 'isCurrent';
		const dateKeys = Array.isArray(options.dateKeys) ? options.dateKeys : [];
		const aCurrent = Boolean(a?.[currentKey]);
		const bCurrent = Boolean(b?.[currentKey]);
		if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;

		for (const key of dateKeys) {
			const diff = parseSortDateValue(b?.[key]) - parseSortDateValue(a?.[key]);
			if (diff !== 0) return diff;
		}

		return String(a?.firmName || a?.label || a?.brochureName || a?.examName || a?.type || '').localeCompare(
			String(b?.firmName || b?.label || b?.brochureName || b?.examName || b?.type || ''),
		);
	}

	function renderRegistrationRole(role, { inactive = false }: { inactive?: boolean } = {}) {
		const normalizedRole = String(role || '')
			.trim()
			.toUpperCase();
		const label =
			normalizedRole === 'B' ? 'Broker'
			: normalizedRole === 'IA' ? 'Investment Adviser'
			: normalizedRole || 'Registration';
		const roleClass =
			normalizedRole === 'B' ? 'fg-reg-role--broker'
			: normalizedRole === 'IA' ? 'fg-reg-role--ia'
			: 'fg-reg-role--default';
		return `<span class='fg-reg-role ${roleClass}${inactive ? ' is-inactive' : ''}' title='${esc(label)}'><span class='fg-reg-role__icon'>${esc(normalizedRole || label.charAt(0))}</span><span class='fg-reg-role__label'>${esc(label)}</span></span>`;
	}

	const currentRegistrations = dedupeRegs([
		...(d.currentIAEmployments || []).map((emp) => regToEntry(emp, 'IA', true)),
		...(d.currentEmployments || []).map((emp) => regToEntry(emp, 'B', true)),
	]).sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['start', 'end'] }));
	const previousRegistrations = dedupeRegs([
		...(d.previousIAEmployments || []).map((emp) => regToEntry(emp, 'IA', false)),
		...(d.previousEmployments || []).map((emp) => regToEntry(emp, 'B', false)),
	]).sort((a, b) => (b.end || '').localeCompare(a.end || ''));

	const hasStoredEmps = d.currentEmployments?.length || d.previousEmployments?.length || d.currentIAEmployments?.length || d.previousIAEmployments?.length;

	let empEntries = [];
	if (hasStoredEmps) {
		empEntries = [
			...(d.currentEmployments || []).map((e) => empToEntry(e, true)),
			...(d.currentIAEmployments || []).map((e) => empToEntry(e, true)),
			...(d.previousEmployments || []).map((e) => empToEntry(e, false)),
			...(d.previousIAEmployments || []).map((e) => empToEntry(e, false)),
		];
		const seen = new Set();
		empEntries = empEntries.filter((e) => {
			const normStart = e.start ? normalizeDateForKey(e.start) : '';
			const key = `${String(e.firmId || e.firmName)
				.trim()
				.toLowerCase()}|${normStart}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		empEntries.sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));
	} else {
		const empLinks = links.filter((l) => l.relationship === 'employed_by');
		empEntries = empLinks.map((l) => {
			const firmNode = graphData?.nodes?.find((n) => n.id === (l.target?.id || l.target));
			let resolvedFirmId = l.firmId || null;
			if (!resolvedFirmId && firmNode) {
				// try common id shapes: 'firm:123' or 'firm_123'
				const m = String(firmNode.id || '').match(/(?:firm[:_])(\d+)/);
				if (m) resolvedFirmId = m[1];
				else if (firmNode.firmId) resolvedFirmId = firmNode.firmId;
			}
			return {
				firmName: firmNode?.label || l.firmName || '',
				firmId: resolvedFirmId,
				start: l.startDate || '',
				end: l.endDate || null,
				isCurrent: !l.endDate,
				iaOnly: false,
				loc: formatLocationText([l.city, l.state].filter(Boolean).join(', ')),
			};
		});
		empEntries.sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));
	}

	const currentEmploymentEntries = empEntries.filter((e) => e.isCurrent);
	const previousEmploymentEntries = empEntries.filter((e) => !e.isCurrent);
	const allEmploymentEntries = [...currentEmploymentEntries, ...previousEmploymentEntries];

	function normalizeFirmKey(value) {
		return String(value || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	}

	function resolveFirmCrdByName(name, providedId) {
		// prefer provided id
		if (providedId) return String(providedId);
		const label = String(name || '').trim();
		if (!label) return null;
		// try find a firm node in graphData by normalized label
		const candidate = graphData?.nodes?.find((n) => n && n.group === 'firm' && normalizeFirmKey(n.label) === normalizeFirmKey(label));
		if (candidate) {
			if (candidate.firmId) return String(candidate.firmId);
			const mid = String(candidate.id || '').match(/(?:firm[:_])(\d+)/);
			if (mid) return mid[1];
		}
		return null;
	}

	function renderFirmNameWithCrd(name, maybeId) {
		const crd = resolveFirmCrdByName(name, maybeId);
		if (crd) {
			return `<button class='fg-crd-link' data-crd='${esc(String(crd))}' title='View this CRD'>${esc(name)}</button>`;
		}
		return esc(name || '');
	}

	function findEmploymentMatchForControl(link, firmNode) {
		const controlFirmId = String(firmNode?.firmId || link?.firmId || link?.firm_id || link?.organizationId || link?.orgId || '').trim();
		const controlFirmName = normalizeFirmKey(firmNode?.label || link?.firmName || link?.name || link?.organizationName || link?.legalName || '');

		const byFirmId = controlFirmId ? allEmploymentEntries.find((entry) => String(entry?.firmId || '').trim() === controlFirmId) : null;
		if (byFirmId) return byFirmId;
		if (!controlFirmName) return null;
		return allEmploymentEntries.find((entry) => normalizeFirmKey(entry?.firmName) === controlFirmName) || null;
	}

	const allExams = [...(d.stateExamCategory || []), ...(d.principalExamCategory || []), ...(d.productExamCategory || [])].sort((a, b) =>
		compareCurrentFirstByDates(a, b, { currentKey: '__never', dateKeys: ['examTakenDate'] }),
	);
	const regStates = Array.isArray(d.registeredStates) ? d.registeredStates.filter(Boolean) : [];
	const licenseCount = regStates.length || (d.registrationCount?.approvedStateRegistrationCount || 0) + (d.registrationCount?.approvedIAStateRegistrationCount || 0);

	function disclosureValueToText(value) {
		if (value == null) return '';
		if (Array.isArray(value)) {
			return value
				.map((item) => disclosureValueToText(item))
				.filter(Boolean)
				.join('; ');
		}
		if (typeof value === 'object') {
			return Object.entries(value)
				.map(([key, nestedValue]) => {
					const nestedText = disclosureValueToText(nestedValue);
					return nestedText ? `${key}: ${nestedText}` : '';
				})
				.filter(Boolean)
				.join(' | ');
		}
		return String(value).trim();
	}

	function disclosureLabelText(key) {
		return String(key || '')
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/[_-]+/g, ' ')
			.trim();
	}

	function disclosureKeyId(key) {
		return String(key || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '');
	}

	function renderDisclosure(dis) {
		const dtype = dis.disclosureType || dis.type || '';
		const ddate = dis.eventDate || dis.date || '';
		const dres = dis.disclosureResolution || dis.resolution || '';
		const dd = dis.disclosureDetail || {};
		const dsource = dis._sourceLabel || '';

		const isObj = dd && typeof dd === 'object' && !Array.isArray(dd);
		const allegs = isObj ? dd['Allegations'] || dd['allegations'] || '' : '';
		const initiatedBy = isObj ? dd['Initiated By'] || dd['initiatedBy'] || '' : '';
		const resolution = isObj ? dd['Resolution'] || dd['resolution'] || '' : '';
		const sanctionText = isObj ? dd['Sanctions'] || dd['sanctions'] || '' : '';
		const sanctionDetails = isObj ? dd['SanctionDetails'] || dd['Sanction Details'] || [] : [];
		const brokerComment = isObj ? dd['Broker Comment'] || dd['brokerComment'] || null : null;
		const settlementAmt = isObj ? dd['Settlement Amount'] || dd['settlementAmount'] || '' : '';
		const docketFDA = isObj ? (dd['DocketNumberFDA'] || '').trim() : '';
		const docketAAO = isObj ? (dd['DocketNumberAAO'] || '').trim() : '';
		const arbDocket = isObj ? dd['arbitrationDocketNumber'] || '' : '';
		const isIAExcl = dis.isIapdExcludedCCFlag === 'Y';
		const isBCExcl = dis.isBcExcludedCCFlag === 'Y';

		const comments =
			Array.isArray(brokerComment) ? brokerComment
			: brokerComment ? [brokerComment]
			: [];
		const sanctionBadges = [...(Array.isArray(sanctionDetails) ? sanctionDetails.map((s) => (typeof s === 'object' ? s.Sanctions || s.sanctions || '' : String(s))) : [])]
			.map((s) => String(s).trim())
			.filter(Boolean);

		const handledDetailKeys = new Set(
			[
				'Allegations',
				'allegations',
				'Initiated By',
				'initiatedBy',
				'Resolution',
				'resolution',
				'Sanctions',
				'sanctions',
				'SanctionDetails',
				'Sanction Details',
				'Broker Comment',
				'brokerComment',
				'Settlement Amount',
				'settlementAmount',
				'DocketNumberFDA',
				'DocketNumberAAO',
				'arbitrationDocketNumber',
			].map((key) => disclosureKeyId(key)),
		);

		const extraDetailRows =
			isObj ?
				Object.entries(dd)
					.map(([key, value]) => ({ key, keyId: disclosureKeyId(key), valueText: disclosureValueToText(value) }))
					.filter(({ keyId, valueText }) => valueText && !handledDetailKeys.has(keyId))
			:	[];

		return `
      <div class='fg-disclosure'>
        <div class='fg-dis-header'>
          <span class='fg-dis-type'>${esc(dtype)}</span>
          ${
						dsource ?
							dsource
								.split(',')
								.map((s) => `<span class='fg-badge inactive'>${esc(s.trim())}</span>`)
								.join(' ')
						:	''
					}
          ${ddate ? `<span class='fg-dis-date'>${esc(ddate)}</span>` : ''}
          ${dres ? `<span class='fg-dis-res ${/final|settled/i.test(dres) ? 'final' : 'pending'}'>${esc(dres)}</span>` : ''}
          ${isIAExcl || isBCExcl ? `<span class='fg-badge inactive' title='Excluded from count'>${isIAExcl ? 'IA-excl' : ''}${isIAExcl && isBCExcl ? ' ' : ''}${isBCExcl ? 'FINRA-excl' : ''}</span>` : ''}
        </div>
        ${initiatedBy ? `<div class='fg-dis-row'><span class='fg-dis-label'>Initiated by:</span> ${esc(initiatedBy)}</div>` : ''}
        ${allegs ? `<div class='fg-dis-row'><span class='fg-dis-label'>Allegations:</span><div class='fg-dis-text'>${esc(allegs)}</div></div>` : ''}
        ${resolution ? `<div class='fg-dis-row'><span class='fg-dis-label'>Resolution:</span> ${esc(resolution)}</div>` : ''}
        ${sanctionText ? `<div class='fg-dis-row'><span class='fg-dis-label'>Sanctions:</span><div class='fg-dis-text'>${esc(sanctionText)}</div></div>` : ''}
        ${settlementAmt ? `<div class='fg-dis-row'><span class='fg-dis-label'>Settlement:</span> <strong>${esc(settlementAmt)}</strong></div>` : ''}
        ${sanctionBadges.length ? `<div class='fg-dis-sanctions'>${sanctionBadges.map((s) => `<span class='fg-badge inactive'>${esc(s)}</span>`).join(' ')}</div>` : ''}
        ${comments.length ? `<div class='fg-dis-row'><span class='fg-dis-label'>Broker comment:</span><div class='fg-dis-text fg-dis-comment'>${comments.map((c) => esc(String(c))).join('<br>')}</div></div>` : ''}
        ${docketFDA || docketAAO || arbDocket ? `<div class='fg-dis-row fg-dis-dockets'>${[docketFDA && `FDA: ${esc(docketFDA)}`, docketAAO && `AAO: ${esc(docketAAO)}`, arbDocket && `Arb: ${esc(arbDocket)}`].filter(Boolean).join(' &nbsp;|&nbsp; ')}</div>` : ''}
        ${extraDetailRows.length ? extraDetailRows.map(({ key, valueText }) => `<div class='fg-dis-row'><span class='fg-dis-label'>${esc(disclosureLabelText(key))}:</span><div class='fg-dis-text'>${esc(valueText)}</div></div>`).join('') : ''}
      </div>`;
	}

	const crd = bi.individualId || d.crd || String(d.id).replace(/^person[:_]/, '');
	const brokerCheckSummaryUrl = crd && hasFinraPage ? `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(crd)}` : null;
	const brokerCheckReportUrl = crd && hasFinraPage ? `https://files.brokercheck.finra.org/individual/individual_${encodeURIComponent(crd)}.pdf` : null;
	const secSummaryUrl = crd && hasSecPage ? `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(crd)}` : null;
	const parentFirmSummaryLinks = buildParentFirmSummaryLinks(d, currentEmploymentEntries);

	return `
    <div class='fg-sb-header individual'>
		<div class='fg-sb-title'>${esc(normalizePersonLabel(d.label || [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ')))}</div>
      <div class='fg-sb-badges'>
        ${scopeBadgesHtml}
        ${stubBadge}
        ${disclosureCount ? `<span class='fg-badge inactive'>${disclosureCount} disclosure${disclosureCount !== 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
    <div class='fg-sb-body fg-sb-body--person'>
      <div class='fg-ext-links'>
        ${brokerCheckSummaryUrl ? `<a class='fg-ext-link bc' href='${brokerCheckSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA Summary</a>` : ''}
        ${brokerCheckReportUrl ? `<a class='fg-ext-link bc' href='${brokerCheckReportUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA Detailed Report (PDF)</a>` : ''}
        ${secSummaryUrl ? `<a class='fg-ext-link sec' href='${secSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; SEC AdvisorInfo Summary</a>` : ''}
        ${parentFirmSummaryLinks.map((link) => `<a class='fg-ext-link ${link.className}' href='${esc(link.href)}' target='_blank' rel='noopener noreferrer'>&#x2197; ${esc(link.label)}</a>`).join('')}
      </div>

      ${bi.individualId ? row('CRD', `<code>${bi.individualId}</code>`) : ''}
	${row('ID source check', esc(formatNodeSourceTruthSummary(d)))}
      ${aliases.length ? row('Also known as', esc(aliases.join('; '))) : ''}
      ${
				d.yearsExperience != null ? row('Years of Experience', esc(String(d.yearsExperience)))
				: d.daysInIndustry != null ? row('Days in Industry', d.daysInIndustry.toLocaleString())
				: ''
			}
      ${typeof d.firmCount === 'number' ? row('Firms (all time)', esc(String(d.firmCount))) : ''}
      ${licenseCount ? row('State Licenses', esc(String(licenseCount))) : ''}
      ${row('Disclosures', esc(String(disclosureCount)))}
	      ${d.primaryOffice?.address ? row('Primary Office', esc(formatLocationText(d.primaryOffice.address)), 'fg-detail-row--stacked') : ''}
      ${
				d.registrationCount ?
					`
        ${d.registrationCount.approvedFinraRegistrationCount != null ? row('FINRA Registrations', esc(String(d.registrationCount.approvedFinraRegistrationCount))) : ''}
        ${d.registrationCount.approvedSRORegistrationCount != null ? row('SRO Registrations', esc(String(d.registrationCount.approvedSRORegistrationCount))) : ''}
        ${d.registrationCount.approvedStateRegistrationCount != null ? row('State Broker Lic.', esc(String(d.registrationCount.approvedStateRegistrationCount))) : ''}
        ${d.registrationCount.approvedIAStateRegistrationCount != null ? row('State (IA) Lic.', esc(String(d.registrationCount.approvedIAStateRegistrationCount))) : ''}
      `
				:	''
			}

	${currentEmploymentEntries.length || previousEmploymentEntries.length ? `<div class='fg-section-title fg-section-title--sticky'>Employment</div>` : ''}

      ${
				currentEmploymentEntries.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Current Employment (${currentEmploymentEntries.length})</div>
            <div class='fg-timeline'>
              ${currentEmploymentEntries
								.map((e) => {
									const detailLine = getEmploymentDetailLine(e);
									const scopeTags = getEmploymentScopeTags(e);
									return `<div class='fg-tl-entry active-pos'>
									  <span class='fg-tl-firm'>${renderFirmNameWithCrd(e.firmName, e.firmId)}${e.bdSecNumber ? ` <small>SEC#${esc(String(e.bdSecNumber))}</small>` : ''}</span>
						                  <span class='fg-tl-dates'>${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>
										  ${detailLine ? `<span class='fg-tl-loc'>${esc(detailLine)}</span>` : ''}
						                  ${scopeTags.length ? `<span class='fg-tl-loc' style='color:var(--text-m)'>${esc(scopeTags.join(' · '))}</span>` : ''}
						                </div>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				previousEmploymentEntries.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Previous Employment (${previousEmploymentEntries.length})</div>
	            <div class='fg-timeline fg-timeline--previous'>
              ${previousEmploymentEntries
								.map((e) => {
									const cls = `fg-tl-entry${e.isCurrent ? ' active-pos' : ''}`;
									const detailLine = getEmploymentDetailLine(e);
									const scopeTags = getEmploymentScopeTags(e);
									return `<div class='${cls}'>
									  <span class='fg-tl-firm'>${renderFirmNameWithCrd(e.firmName, e.firmId)}${e.bdSecNumber ? ` <small>SEC#${esc(e.bdSecNumber)}</small>` : ''}</span>
						                  <span class='fg-tl-dates'>${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>
										  ${detailLine ? `<span class='fg-tl-loc'>${esc(detailLine)}</span>` : ''}
						                  ${scopeTags.length ? `<span class='fg-tl-loc' style='color:var(--text-m)'>${esc(scopeTags.join(' · '))}</span>` : ''}
						                  ${e.expelledDate ? `<span class='fg-badge inactive'>Expelled ${esc(e.expelledDate)}</span>` : ''}
						                </div>`;
								})
								.join('')}
            </div>`
				:	`<div class='fg-section-title fg-section-title--sticky'>Previous Employment</div>
            <div class='fg-empty-state' style='margin-top:8px'>No previous employment records found for this profile.</div>`
			}

      ${
				currentRegistrations.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Current Registrations</div>
            <div class='fg-timeline'>
              ${currentRegistrations
								.map(
									(reg) => `
                <div class='fg-tl-entry active-pos'>
									<span class='fg-tl-firm'>${renderRegistrationRole(reg.role)} ${
										reg.firmId ?
											`<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>${esc(reg.firmName)}</button> (<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>CRD#${esc(String(reg.firmId))}</button>)`
										:	esc(reg.firmName)
									}</span>
                  ${
										reg.officeAddress ? `<span class='fg-tl-loc'>${esc(reg.officeAddress)}</span>`
										: reg.cityState ? `<span class='fg-tl-loc'>${esc(reg.cityState)}</span>`
										: ''
									}
                  ${reg.start ? `<span class='fg-tl-dates'>Registered since ${esc(reg.start)}</span>` : ''}
                </div>`,
								)
								.join('')}
            </div>`
				:	''
			}

      ${
				previousRegistrations.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Previous Registrations</div>
	            <div class='fg-timeline fg-timeline--previous'>
              ${previousRegistrations
								.map(
									(reg) => `
                <div class='fg-tl-entry'>
									<span class='fg-tl-firm'>${renderRegistrationRole(reg.role, { inactive: true })} ${
										reg.firmId ?
											`<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>${esc(reg.firmName)}</button> (<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>CRD#${esc(String(reg.firmId))}</button>)`
										:	esc(reg.firmName)
									}</span>
                  ${reg.cityState ? `<span class='fg-tl-loc'>${esc(reg.cityState)}</span>` : ''}
                  <span class='fg-tl-dates'>${esc(reg.start || '–')} → ${esc(reg.end || 'present')}</span>
                </div>`,
								)
								.join('')}
            </div>`
				:	''
			}

      ${
				d.registeredSROs?.length ?
					`<details class='fg-section-toggle'>
			      <summary class='fg-section-title fg-section-title--sticky'>Registered SROs (${d.registeredSROs.length})</summary>
              ${d.registeredSROs
								.map((sro) => {
									const name = esc(sro.sro || sro.name || '');
									const status = sro.status ? ` <span class='fg-badge ${/approved/i.test(sro.status) ? 'active' : 'inactive'}'>${esc(sro.status)}</span>` : '';
									const categories =
										Array.isArray(sro.CategoriesList) ? sro.CategoriesList
										: typeof sro.CategoriesList === 'string' ? [sro.CategoriesList]
										: [];
									const categoryItems = categories
										.flatMap((item) => String(item).split(/\s*[;,]\s*/))
										.map((item) => item.trim())
										.filter(Boolean);
									const cats = categoryItems.length ? `<ul class='fg-sro-cat-list'>${categoryItems.map((cat) => `<li>${esc(cat)}</li>`).join('')}</ul>` : '';
									return `<div class='fg-detail-row'><span class='fg-label'>${name}${status}</span>${cats}</div>`;
								})
								.join('')}
            </details>`
				:	''
			}

      ${
				regStates.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Registered States</div>
            <div class='fg-states-grid'>
              ${regStates
								.map((s) => {
									const stateStr = typeof s === 'object' ? s.state || '' : String(s);
									const scope = typeof s === 'object' ? s.regScope || '' : '';
									const scopeDisplay = /^bc$/i.test(String(scope).trim()) ? '' : String(scope).trim();
									const status = typeof s === 'object' ? s.status || '' : '';
									const regDate = typeof s === 'object' ? s.regDate || '' : '';
									const cls = /approved/i.test(status) ? 'active' : 'inactive';
									return `<span class='fg-state-pill ${cls}' title='${esc([scopeDisplay, status, regDate ? `since ${regDate}` : ''].filter(Boolean).join(' | '))}'>${esc(stateStr)}${scopeDisplay ? ` <small>${esc(scopeDisplay)}</small>` : ''}</span>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				controlLinks.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Control Positions</div>
            ${controlLinks
							.slice()
							.sort((a, b) =>
								compareCurrentFirstByDates(
									{
										isCurrent: !a.endDate && !a.registrationEndDate && !a.toDate,
										end: a.endDate || a.registrationEndDate || a.toDate,
										start: a.startDate || a.registrationBeginDate || a.fromDate || a.effectiveDate || a.date,
									},
									{
										isCurrent: !b.endDate && !b.registrationEndDate && !b.toDate,
										end: b.endDate || b.registrationEndDate || b.toDate,
										start: b.startDate || b.registrationBeginDate || b.fromDate || b.effectiveDate || b.date,
									},
									{ dateKeys: ['end', 'start'] },
								),
							)
							.map((l) => {
								const firmNode = graphData?.nodes?.find((n) => n.id === (l.target?.id || l.target));
								const employmentMatch = findEmploymentMatchForControl(l, firmNode);
								const firmAddress =
									firmNode?.officeAddress ||
									l.officeAddress ||
									l.address ||
									employmentMatch?.addr ||
									[l.street1, l.street2, l.city, l.state, l.postalCode, l.zipCode, l.zip, l.country].filter(Boolean).join(', ') ||
									null;
								const firmStatus =
									firmNode?.firmStatus || l.firmStatus || l.status || l.registrationStatus || employmentMatch?.employmentStatus || employmentMatch?.firmBCScope || null;
								const secNumber =
									firmNode?.bdSecNumber || firmNode?.iaSecNumber || l.bdSecNumber || l.iaSecNumber || employmentMatch?.bdSecNumber || employmentMatch?.iaSECNumber || null;
								const startDate = l.startDate || l.registrationBeginDate || l.fromDate || l.effectiveDate || l.date || employmentMatch?.start || null;
								const endDate = l.endDate || l.registrationEndDate || l.toDate || employmentMatch?.end || null;
								const dateRange = startDate ? `${esc(startDate)} → ${esc(endDate || 'present')}` : null;
								const location =
									l.location ||
									employmentMatch?.loc ||
									(l.city || l.officeCity || l.state || l.officeState ? [l.city || l.officeCity, l.state || l.officeState].filter(Boolean).join(', ') : null);
								return `<div class='fg-tl-entry active-pos'>
									<span class='fg-tl-firm'>${renderFirmNameWithCrd(firmNode?.label || l.firmName || employmentMatch?.firmName || l.name || l.organizationName || l.legalName || '', firmNode?.firmId || l.firmId || employmentMatch?.firmId)}${secNumber ? ` <small>SEC#${esc(String(secNumber))}</small>` : ''}</span>
                  ${dateRange ? `<span class='fg-tl-dates'>${dateRange}</span>` : ''}
                  ${firmStatus ? `<span class='fg-tl-status'>${esc(firmStatus)}</span>` : ''}
                  ${l.position ? `<span class='fg-tl-loc'>${esc(l.position)}</span>` : ''}
                  ${location ? `<span class='fg-tl-loc'>${esc(location)}</span>` : ''}
                  ${firmAddress ? `<span class='fg-tl-loc'>${esc(firmAddress)}</span>` : ''}
              </div>`;
							})
							.join('')}`
				:	''
			}

      ${
				allExams.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Qualifications &amp; Exams (${allExams.length})</div>
            <div class='fg-timeline'>
              ${allExams
								.map((ex) => {
									const examScopeDisplay = /^bc$/i.test(String(ex.examScope || '').trim()) ? '' : String(ex.examScope || '').trim();
									return `<div class='fg-tl-entry'>
                  <span class='fg-tl-firm'>${esc(ex.examCategory || '')} – ${esc(ex.examName || '')}</span>
                  ${ex.examTakenDate ? `<span class='fg-tl-dates'>Passed: ${esc(ex.examTakenDate)}</span>` : ''}
                  ${examScopeDisplay ? `<span class='fg-tl-loc'>${esc(examScopeDisplay)}</span>` : ''}
                </div>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				allDisclosures.length ?
					`<details class='fg-section-toggle'>
			<summary class='fg-section-title fg-section-title--sticky'>Disclosures (${allDisclosures.length})</summary>
            ${allDisclosures.map(renderDisclosure).join('')}
          </details>`
				: d.disclosureFlag === 'Y' || d.iaDisclosureFlag === 'Y' ?
					`<details class='fg-section-toggle'>
			<summary class='fg-section-title fg-section-title--sticky'>Disclosures</summary>
            <p class='fg-sb-note'>FINRA or SEC marks this record as having disclosures, but the current API response did not include structured disclosure bodies for this profile.</p>
            <div class='fg-ext-links'>
              ${brokerCheckSummaryUrl ? `<a class='fg-ext-link bc' href='${brokerCheckSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; Open FINRA Summary</a>` : ''}
              ${brokerCheckReportUrl ? `<a class='fg-ext-link bc' href='${brokerCheckReportUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; Open FINRA Detailed Report (PDF)</a>` : ''}
              ${secSummaryUrl ? `<a class='fg-ext-link sec' href='${secSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; Open SEC AdvisorInfo Summary</a>` : ''}
            </div>
          </details>`
				:	''
			}
    </div>
  `;
}

export function renderFirmDetail(d: any) {
	const statusDate = d.firmStatusDate || '';
	const statusText = d.firmStatus ? capitalize(String(d.firmStatus || '').toLowerCase()) : '';
	const statusIsActive = d.firmStatus ? /\bactive\b|\bapproved\b/i.test(String(d.firmStatus)) : false;
	const statusIsTerminated = d.firmStatus ? /terminated|inactive|revoked|suspended/i.test(String(d.firmStatus)) : false;
	const statusClass =
		statusIsActive ? 'active'
		: statusIsTerminated ? 'terminated'
		: 'inactive';
	const statusBadge = d.firmStatus ? `<span class='fg-badge ${statusClass}'>${esc(statusText)}${statusDate ? ` ${statusDate}` : ''}</span>` : '';
	const legacyBadge = d.isLegacy === 'Y' ? `<span class='fg-badge inactive'>PR Previously Registered Brokerage Firm</span>` : '';
	const scopeBadge =
		d.bcScope ?
			`<span class='fg-badge ${/\b(active|approved)\b/i.test(String(d.bcScope)) ? 'active' : 'inactive'}'>${esc(capitalize(String(d.bcScope || '').toLowerCase()))}</span>`
		:	'';
	const sros = Array.isArray(d.selfRegulatoryOrgs) && d.selfRegulatoryOrgs.length ? d.selfRegulatoryOrgs.join(', ') : 'N/A';
	const states = Array.isArray(d.activeStates) && d.activeStates.length ? d.activeStates.join(', ') : 'N/A';
	const firmId = d.firmId || String(d.id).replace(/^firm[:_]/, '');
	const normalizeSecFirmId = (value: string | number | null | undefined) => {
		const raw = String(value || '').trim();
		if (!raw) return '';
		if (/^8-\d+$/i.test(raw)) return raw;
		if (/^\d+$/.test(raw)) return `8-${raw}`;
		return raw;
	};
	const secFirmId = normalizeSecFirmId(d.iaSecNumber || d.bdSecNumber || d.bdSECNumber || d.basicInformation?.iaSECNumber || d.basicInformation?.bdSECNumber || firmId);
	const crdSec = [firmId ? `CRD#: ${firmId}` : null, secFirmId ? `SEC#: ${secFirmId}` : null].filter(Boolean).join(' / ');
	const secSummaryUrl = firmId ? `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}` : null;

	const hasFinraPage = hasFirmFinraPresence(d);
	const hasSecPage = hasFirmSecPresence(d);

	const secDocumentLinks =
		hasSecPage ?
			(() => {
				const defaultLinks =
					firmId ?
						[
							{ label: 'SEC AdvisorInfo Summary', href: secSummaryUrl },
							{ label: 'Latest Form ADV filed', href: `https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(firmId)}/PDF/${encodeURIComponent(firmId)}.pdf` },
							{ label: 'SEC firm brochure', href: `https://adviserinfo.sec.gov/firm/brochure/${encodeURIComponent(firmId)}` },
							{ label: 'SEC Form CRS', href: `https://reports.adviserinfo.sec.gov/crs/crs_${encodeURIComponent(firmId)}.pdf` },
						]
					:	[];

				if (!Array.isArray(d.secDocumentLinks) || !d.secDocumentLinks.length) return defaultLinks;

				return d.secDocumentLinks.map((link: any) => {
					const label = String(link?.label || '').trim();
					if (!label) return link;
					if (/^SEC AdvisorInfo Summary$/i.test(label)) return { ...link, href: secSummaryUrl };
					if (/^Latest Form ADV filed$/i.test(label)) {
						return {
							...link,
							href: `https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(firmId)}/PDF/${encodeURIComponent(firmId)}.pdf`,
						};
					}
					if (/^SEC firm brochure$/i.test(label)) {
						return { ...link, href: `https://adviserinfo.sec.gov/firm/brochure/${encodeURIComponent(firmId)}` };
					}
					if (/^SEC Form CRS$/i.test(label)) {
						return { ...link, href: `https://reports.adviserinfo.sec.gov/crs/crs_${encodeURIComponent(firmId)}.pdf` };
					}
					return link;
				});
			})()
		:	[];
	const secSummaryDescription = hasSecPage && d.secSummaryDescription ? String(d.secSummaryDescription).trim() : '';
	const showBrokerCheckSummary = hasFinraPage;

	const officeAddressRaw = String(d.officeAddress || '').trim();
	const officeAddress = /^(?:-|n\/?a|na|none|null|undefined)$/i.test(officeAddressRaw) ? '' : officeAddressRaw;
	const hasOfficeAddress = Boolean(officeAddress);
	const businessPhone = String(d.businessPhone || '').trim();

	return `
		<div class='fg-sb-header firm'>
			<div class='fg-sb-title'>${esc(d.label)}</div>
			${crdSec ? `<div class='fg-sb-crd'>${crdSec}</div>` : ''}
      <div class='fg-sb-badges'>
        ${legacyBadge}
        ${(() => {
					if (d.firmSize && d.firmStatus) {
						const combined = `${esc(firmSizeLabel(d.firmSize))} - ${esc(statusText)}`;
						return `<span class='fg-badge ${statusClass}'>${combined}</span>`;
					}
					return `${statusBadge}${d.firmSize ? `<span class='fg-badge'>${esc(firmSizeLabel(d.firmSize))}</span>` : ''}`;
				})()}
        ${scopeBadge}
      </div>
    </div>
    <div class='fg-sb-body'>
      <div class='fg-ext-links'>
        ${showBrokerCheckSummary ? `<a class='fg-ext-link bc' href='https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA Summary</a>` : ''}
        ${secDocumentLinks.map((link) => (link?.href ? `<a class='fg-ext-link sec' href='${esc(link.href)}' target='_blank' rel='noopener noreferrer'>&#x2197; ${esc(link.label)}</a>` : '')).join('')}
      </div>
      ${secSummaryDescription ? `<div class='fg-section-title'>SEC summary</div><p class='fg-sb-note'>${esc(secSummaryDescription)}</p>` : ''}
      ${d.isLegacy === 'Y' ? `<p class='fg-sb-note'>Not currently registered as broker. FINRA contains only limited information about this firm.</p>` : ''}
      ${
				hasOfficeAddress || businessPhone ?
					`
      <div class='fg-section-title'>Contact</div>
      ${hasOfficeAddress ? row('Address', esc(officeAddress)) : ''}
      ${businessPhone ? row('Phone', esc(businessPhone)) : ''}
      `
				:	''
			}
      <div class='fg-section-title'>Registration</div>
	${row('ID source check', esc(formatNodeSourceTruthSummary(d)))}
      ${row('SEC Registration Status', d.firmStatus ? esc(d.firmStatus) + (statusDate ? ` (${statusDate})` : '') : '–')}
      ${d.districtName ? row('FINRA District', esc(d.districtName)) : ''}
      ${row('Company Type', esc(d.firmType || 'N/A'))}
      ${row('Self-Regulatory Orgs', esc(sros))}
      ${row(
				'U.S. States &amp; Territories',
				states !== 'N/A' ? esc(states)
				: d.activeStates?.length ? `${d.activeStates.length} states/territories`
				: 'N/A',
			)}
      ${row('Regulator', esc(d.regulator || '–'))}
      ${
				Array.isArray(d.directOwners) && d.directOwners.length ?
					`
      <div class='fg-section-title'>Direct Owners &amp; Executive Officers (${d.directOwners.length})</div>
      <div class='fg-timeline'>
        ${d.directOwners
					.map((owner: any) => {
						const name = owner.legalName || owner.name || `Person ${owner.crdNumber || owner.crd || ''}`;
						const position = owner.position || '';
						const ownership = owner.ownershipCode || owner.ownership || '';
						const crd = owner.crdNumber || owner.crd || '';
						return `<div class='fg-tl-entry'>
            <span class='fg-tl-firm'>${esc(name)}${crd ? ` <small>(CRD# ${esc(String(crd))})</small>` : ''}</span>
            ${position ? `<span class='fg-tl-dates'>${esc(position)}</span>` : ''}
            ${ownership ? `<span class='fg-tl-loc'>Ownership: ${esc(ownership)}</span>` : ''}
          </div>`;
					})
					.join('')}
      </div>
      `
				:	''
			}
      <div class='fg-section-title'>General Information</div>
      ${row('Established in', d.formedState ? `${esc(d.formedState)}${d.formedDate ? ' since ' + d.formedDate : ''}` : '–')}
      ${row('Type', esc(d.firmType || '–'))}
      ${row('Fiscal Year End', esc(d.fiscalYearEnd || '–'))}
      ${d.otherNames?.length ? row('Other names', esc(d.otherNames.join('; '))) : ''}
    </div>
  `;
}
