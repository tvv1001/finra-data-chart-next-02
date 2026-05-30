import { NextRequest, NextResponse } from 'next/server';
import { mergedIndividual } from '@/lib/dataMerge';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '@/lib/constants';

function parseDetailPayload(data: any, contentKey = 'content') {
	if (!data) return null;
	if (data?.hits?.hits?.length) {
		const raw = data.hits.hits[0]?._source?.[contentKey];
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
		}
	}

	const raw = data?.[contentKey];
	if (raw != null) {
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
		}
	}

	if (isPlainObject(data)) {
		const looksLikeDetail =
			data.basicInformation ||
			data.individualId ||
			data.firstName ||
			data.lastName ||
			data.bcScope ||
			data.iaScope ||
			data.disclosures ||
			data.currentEmployments ||
			data.previousEmployments;
		if (looksLikeDetail) return data;
	}

	return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergePreferPrimary(primary: unknown, secondary: unknown): unknown {
	if (primary == null || primary === '') return secondary;
	if (secondary == null || secondary === '') return primary;
	if (Array.isArray(primary) && Array.isArray(secondary)) {
		if (!primary.length) return secondary;
		if (!secondary.length) return primary;
		const seen = new Set(primary.map((item) => JSON.stringify(item)));
		return [
			...primary,
			...secondary.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		];
	}
	if (isPlainObject(primary) && isPlainObject(secondary)) {
		const merged: Record<string, unknown> = { ...primary };
		for (const [key, value] of Object.entries(secondary)) {
				let finraDetail = parseDetailPayload(data.sources.finra || {}, 'content');
				let secDetail = parseDetailPayload(data.sources.sec || {}, 'iacontent');
				let mergedDetail: any = secDetail ? mergePreferPrimary(secDetail, finraDetail) : finraDetail;

				// Fallback: if downstream merged detail looks sparse (e.g. no employments)
				// try to load a precomputed derived merged file from DATA_DIR/derived/merged-individual-<crd>.json
				try {
					const derivedPath = path.join(DATA_DIR, 'derived', `merged-individual-${crd}.json`);
					const raw = await readFile(derivedPath, 'utf-8').catch(() => '');
					if (raw) {
						const parsed = JSON.parse(raw || '{}');
						// prefer using the derived merged record when it contains richer employment lists
						if (parsed && typeof parsed === 'object') {
							const hasDerivedEmps = (Array.isArray(parsed.currentEmployments) && parsed.currentEmployments.length > 0) || (Array.isArray(parsed.previousEmployments) && parsed.previousEmployments.length > 0);
							const hasMergedEmps = (mergedDetail && Array.isArray(mergedDetail.currentEmployments) && mergedDetail.currentEmployments.length > 0) || (mergedDetail && Array.isArray(mergedDetail.previousEmployments) && mergedDetail.previousEmployments.length > 0);
							if (hasDerivedEmps && !hasMergedEmps) {
								mergedDetail = parsed;
								// also refresh finra/sec detail pointers where available
								finraDetail = finraDetail || parsed;
								secDetail = secDetail || null;
							}
						}
					}
				} catch (e) {
					// non-fatal fallback; ignore and continue with existing mergedDetail
				}
	}
	return primary;
}

function normalizeMergedIndividualDetail(detail: any, crd: string) {
	// Ensure we always return an object with expected shape so the client
	// can rely on arrays/fields even when primed-cache entries are sparse.
	const out: any = detail && typeof detail === 'object' ? { ...detail } : {};

	if (!out.basicInformation) {
		const bi: any = {};
		if (out.individualId || out.ind_source_id || out.crd || crd) {
			bi.individualId = out.individualId || out.ind_source_id || out.crd || crd;
		} else if (crd) {
			bi.individualId = crd;
		}
		if (out.firstName) bi.firstName = out.firstName;
		if (out.middleName) bi.middleName = out.middleName;
		if (out.lastName) bi.lastName = out.lastName;
		if (out.name) bi.name = out.name;
		if (out.bcScope) bi.bcScope = out.bcScope;
		if (out.iaScope) bi.iaScope = out.iaScope;
		if (out.otherNames) bi.otherNames = out.otherNames;
		out.basicInformation = bi;
	}

	// Ensure list fields exist as arrays (possibly empty)
	const listFields = [
		'currentEmployments',
		'previousEmployments',
		'currentIAEmployments',
		'previousIAEmployments',
		'disclosures',
		'iaDisclosures',
		'registeredStates',
		'registeredSROs',
		'otherNames',
	];
	for (const f of listFields) {
		if (!Array.isArray(out[f])) out[f] = Array.isArray(out[f]) ? out[f] : [];
	}

	// Normalize common employment field variants into canonical keys the client expects
	function normalizeEmploymentEntry(entry: any) {
		if (!entry || typeof entry !== 'object') return entry;
		const e: any = { ...entry };
		// firm id/name
		if (e.firm_id && !e.firmId) e.firmId = e.firm_id;
		if (e.firm_name && !e.firmName) e.firmName = e.firm_name;
		// SEC numbers
		if (e.firm_bd_sec_number && !e.bdSECNumber) e.bdSECNumber = String(e.firm_bd_sec_number || '').trim();
		if (e.firm_bd_full_sec_number && !e.bdSECNumber) e.bdSECNumber = String(e.firm_bd_full_sec_number || '').trim();
		if (e.bdSECNumber && !e.bdSecNumber) e.bdSecNumber = e.bdSECNumber;
		if (e.ia_sec_number && !e.iaSECNumber) e.iaSECNumber = String(e.ia_sec_number || '').trim();
		if (e.iaSECNumber && !e.iaSecNumber) e.iaSecNumber = e.iaSECNumber;
		// branch / location
		if (e.branch_city && !e.city) e.city = e.branch_city;
		if (e.branch_state && !e.state) e.state = e.branch_state;
		if (e.branch_postal_code && !e.zipCode) e.zipCode = e.branch_postal_code;
		if (e.zip && !e.zipCode) e.zipCode = e.zip;
		// registration dates / fields
		if (e.registration_begin_date && !e.registrationBeginDate) e.registrationBeginDate = e.registration_begin_date;
		if (e.registration_end_date && !e.registrationEndDate) e.registrationEndDate = e.registration_end_date;
		if (e.startDate && !e.registrationBeginDate) e.registrationBeginDate = e.startDate;
		if (e.endDate && !e.registrationEndDate) e.registrationEndDate = e.endDate;
		// ia flag variations
		if (e.ia_only != null && e.iaOnly == null) e.iaOnly = e.ia_only;
		if (typeof e.iaOnly === 'boolean') e.iaOnly = e.iaOnly ? 'Y' : 'N';
		// employment status variants
		if (!e.employmentStatus) e.employmentStatus = e.status || e.currentStatus || null;
		// normalize branchOfficeLocations if present as single object
		if (e.branchOfficeLocations && !Array.isArray(e.branchOfficeLocations) && typeof e.branchOfficeLocations === 'object') {
			e.branchOfficeLocations = [e.branchOfficeLocations];
		}
		return e;
	}

	for (const arrName of ['currentEmployments', 'previousEmployments', 'currentIAEmployments', 'previousIAEmployments']) {
		if (Array.isArray(out[arrName])) {
			out[arrName] = out[arrName].map(normalizeEmploymentEntry);
		}
	}

	// Numeric counters and registration count object
	// Ensure registrationCount is an object with expected fields so the client
	// can safely read properties like approvedFinraRegistrationCount.
	const defaultRegCount = {
		approvedFinraRegistrationCount: 0,
		approvedSRORegistrationCount: 0,
		approvedStateRegistrationCount: 0,
		approvedIAStateRegistrationCount: 0,
	};
	if (out.registrationCount == null) {
		out.registrationCount = { ...defaultRegCount };
	} else if (typeof out.registrationCount === 'number') {
		// numeric legacy value -> map to total-ish field by populating approvedFinraRegistrationCount
		out.registrationCount = { ...defaultRegCount, approvedFinraRegistrationCount: Number(out.registrationCount) || 0 };
	} else if (isPlainObject(out.registrationCount)) {
		out.registrationCount = {
			approvedFinraRegistrationCount: Number((out.registrationCount as any).approvedFinraRegistrationCount) || 0,
			approvedSRORegistrationCount: Number((out.registrationCount as any).approvedSRORegistrationCount) || 0,
			approvedStateRegistrationCount: Number((out.registrationCount as any).approvedStateRegistrationCount) || 0,
			approvedIAStateRegistrationCount: Number((out.registrationCount as any).approvedIAStateRegistrationCount) || 0,
		};
	} else {
		out.registrationCount = { ...defaultRegCount };
	}
	out.examsCount = out.examsCount != null ? Number(out.examsCount) : 0;

	// Broker details object
	if (!out.brokerDetails || typeof out.brokerDetails !== 'object') out.brokerDetails = out.brokerDetails || null;

	// Flags indicating source presence
	if (out.hasFinraData == null) out.hasFinraData = Boolean(detail && detail.hasFinraData);
	if (out.hasSecData == null) out.hasSecData = Boolean(detail && detail.hasSecData);

	return out;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ crd: string }> }) {
	const { crd } = await params;
	if (!/^[0-9]+$/.test(crd)) {
		return NextResponse.json({ error: 'Invalid CRD' }, { status: 400 });
	}
	try {
		const data = await mergedIndividual(crd);
		if (!data.found) {
			return NextResponse.json({ found: false }, { headers: sharedCacheHeaders(3600) });
		}

		const finraDetail = parseDetailPayload(data.sources.finra || {}, 'content');
		const secDetail = parseDetailPayload(data.sources.sec || {}, 'iacontent');
		const mergedDetail: any = secDetail ? mergePreferPrimary(secDetail, finraDetail) : finraDetail;
		if (mergedDetail) {
			mergedDetail.hasSecData = !!secDetail;
			mergedDetail.hasFinraData = !!finraDetail;
		}
		const normalizedMergedDetail = normalizeMergedIndividualDetail(mergedDetail, crd);

		return NextResponse.json(
			{
				...data,
				merged: normalizedMergedDetail,
			},
			{ headers: sharedCacheHeaders(3600) },
		);
	} catch (err: any) {
		logger.error('merged individual error', { crd, error: err?.message });
		return NextResponse.json({ error: 'Failed to compute merged record' }, { status: 500 });
	}
}
