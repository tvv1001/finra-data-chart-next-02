#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = process.cwd();
const NATIONAL_DIR = path.join(ROOT, 'data', 'national');
const FINRA_DIR = path.join(NATIONAL_DIR, 'brokercheck.finra.org');
const SEC_DIR = path.join(NATIONAL_DIR, 'adviserinfo.sec.gov');

const BUCKETS = [
	{
		name: 'finra:individual',
		source: 'finra',
		type: 'individual',
		dir: FINRA_DIR,
		filePattern: /^(?:api\.brokercheck\.finra\.org_search_individual_|finra:individual:)\d+\.json$/,
	},
	{
		name: 'finra:firm',
		source: 'finra',
		type: 'firm',
		dir: FINRA_DIR,
		filePattern: /^(?:api\.brokercheck\.finra\.org_search_firm_|finra:firm:)\d+\.json$/,
	},
	{
		name: 'sec:individual',
		source: 'sec',
		type: 'individual',
		dir: SEC_DIR,
		filePattern: /^(?:api\.adviserinfo\.sec\.gov_search_individual_|sec:individual:)\d+\.json$/,
	},
	{
		name: 'sec:firm',
		source: 'sec',
		type: 'firm',
		dir: SEC_DIR,
		filePattern: /^(?:api\.adviserinfo\.sec\.gov_search_firm_|sec:firm:)\d+\.json$/,
	},
];

function toText(value) {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}

function uniqueTexts(values) {
	const seen = new Set();
	const out = [];
	for (const value of values) {
		const text = toText(value);
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(text);
	}
	return out;
}

function collectScalarTexts(value, out = [], seen = new WeakSet()) {
	if (value == null) return out;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectScalarTexts(entry, out, seen);
		return out;
	}
	if (typeof value === 'object') {
		if (seen.has(value)) return out;
		seen.add(value);
		for (const entry of Object.values(value)) collectScalarTexts(entry, out, seen);
	}
	return out;
}

function ensureArray(value) {
	return Array.isArray(value) ? value : [];
}

function normalizeBranchLocation(location) {
	if (!location || typeof location !== 'object') return null;
	const normalized = {
		city: toText(location.city) || null,
		state: toText(location.state) || null,
		street1: toText(location.street1) || null,
		street2: toText(location.street2) || null,
		zipCode: toText(location.zipCode) || null,
	};
	return Object.values(normalized).some(Boolean) ? normalized : null;
}

function normalizeEmployment(employment) {
	if (!employment || typeof employment !== 'object') return null;
	const firmId = toText(employment.firmId ?? employment.firm_id ?? employment.firmIdNumber);
	const firmName = toText(employment.firmName ?? employment.firm_name);
	const branchOfficeLocations = ensureArray(employment.branchOfficeLocations).map(normalizeBranchLocation).filter(Boolean);
	const branchLocation = branchOfficeLocations[0] || null;
	return {
		firmId: firmId ? Number(firmId) || firmId : null,
		firm_id: firmId ? Number(firmId) || firmId : null,
		firmName: firmName || null,
		firm_name: firmName || null,
		iaOnly: employment.iaOnly ?? null,
		registrationBeginDate: employment.registrationBeginDate ?? null,
		registrationEndDate: employment.registrationEndDate ?? null,
		employmentStatus: employment.employmentStatus ?? null,
		firmBCScope: employment.firmBCScope ?? employment.firm_bc_scope ?? null,
		firmIAScope: employment.firmIAScope ?? employment.firm_ia_scope ?? null,
		bdSECNumber: toText(employment.bdSECNumber ?? employment.bdSecNumber ?? employment.firm_bd_sec_number) || null,
		iaSECNumber: toText(employment.iaSECNumber ?? employment.iaSecNumber ?? employment.firm_ia_sec_number) || null,
		city: toText(employment.city ?? branchLocation?.city) || null,
		state: toText(employment.state ?? branchLocation?.state) || null,
		zipCode: toText(employment.zipCode ?? branchLocation?.zipCode) || null,
		expelledDate: employment.expelledDate ?? null,
		branchOfficeLocations,
	};
}

function normalizeEmployments(employments) {
	return ensureArray(employments).map(normalizeEmployment).filter(Boolean);
}

function getCurrentEmploymentFirmNames(detail) {
	return uniqueTexts([
		...normalizeEmployments(detail.currentEmployments).map((employment) => employment.firmName),
		...normalizeEmployments(detail.currentIAEmployments).map((employment) => employment.firmName),
		...ensureArray(detail.previousEmployments).map((employment) => employment?.firmName ?? employment?.firm_name),
		...ensureArray(detail.previousIAEmployments).map((employment) => employment?.firmName ?? employment?.firm_name),
	]);
}

function getRegistrationCount(detail) {
	const registrations = detail?.registrations && typeof detail.registrations === 'object' ? detail.registrations : {};
	return {
		approvedFinraRegistrationCount: registrations.approvedFinraRegistrationCount ?? 0,
		approvedSRORegistrationCount: registrations.approvedSRORegistrationCount ?? 0,
		approvedStateRegistrationCount: registrations.approvedStateRegistrationCount ?? 0,
		approvedIAStateRegistrationCount: registrations.approvedIAStateRegistrationCount ?? 0,
	};
}

function buildIndividualDoc(source, detail) {
	const basicInformation = detail?.basicInformation && typeof detail.basicInformation === 'object' ? detail.basicInformation : {};
	const individualId = toText(basicInformation.individualId ?? detail.individualId);
	if (!individualId) return null;

	const otherNames = uniqueTexts(basicInformation.otherNames);
	const currentEmployments = normalizeEmployments(detail.currentEmployments);
	const currentIAEmployments = normalizeEmployments(detail.currentIAEmployments);
	const registrationCount = getRegistrationCount(detail);

	const currentAddressTexts = uniqueTexts([
		...currentEmployments.flatMap((e) => [e.city, e.state, ...e.branchOfficeLocations.flatMap((l) => [l.street1, l.street2, l.city, l.state])]),
		...currentIAEmployments.flatMap((e) => [e.city, e.state, ...e.branchOfficeLocations.flatMap((l) => [l.street1, l.street2, l.city, l.state])]),
	]);

	const nameTexts = uniqueTexts([basicInformation.firstName, basicInformation.middleName, basicInformation.lastName, ...otherNames]);
	const hit = {
		ind_source_id: individualId,
		ind_crd: individualId,
		ind_firstname: toText(basicInformation.firstName),
		ind_middlename: toText(basicInformation.middleName),
		ind_lastname: toText(basicInformation.lastName),
		ind_other_names: otherNames,
		otherNames,
		ind_bc_scope: toText(basicInformation.bcScope),
		ind_ia_scope: toText(basicInformation.iaScope),
		ind_approved_finra_registration_count: registrationCount.approvedFinraRegistrationCount,
		ind_approved_sro_registration_count: registrationCount.approvedSRORegistrationCount,
		ind_approved_state_registration_count: registrationCount.approvedStateRegistrationCount,
		ind_approved_ia_state_registration_count: registrationCount.approvedIAStateRegistrationCount,
		ind_current_employments: currentEmployments,
		ind_ia_current_employments: currentIAEmployments,
		disclosureFlag: detail.bdDisclosureFlag ?? detail.disclosureFlag ?? null,
		iaDisclosureFlag: detail.iaDisclosureFlag ?? null,
	};

	return {
		id: `${source}:individual:${individualId}`,
		type: 'individual',
		source,
		nameSearchText: nameTexts.join(' ').toLowerCase(),
		addressSearchText: currentAddressTexts.join(' ').toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(' ').toLowerCase(),
		searchText: uniqueTexts([individualId, ...nameTexts]).join(' ').toLowerCase(),
		hit,
	};
}

function buildFirmDoc(source, detail) {
	const basicInformation = detail?.basicInformation && typeof detail.basicInformation === 'object' ? detail.basicInformation : {};
	const firmId = toText(basicInformation.firmId ?? detail.firmId);
	if (!firmId) return null;

	const firmName = toText(basicInformation.firmName);
	const otherNames = uniqueTexts(basicInformation.otherNames);

	const addressDetails = detail.firmAddressDetails || {};
	const office = addressDetails.officeAddress || {};
	const mailing = addressDetails.mailingAddress || {};
	const currentAddressTexts = uniqueTexts([office.city, office.state, office.street1, office.street2, mailing.city, mailing.state, mailing.street1, mailing.street2]);

	const registrationStatuses = ensureArray(detail.registrationStatus).map((status) => toText(status?.status));
	const nameTexts = uniqueTexts([firmName, ...otherNames]);
	const hit = {
		firm_id: firmId,
		firmId,
		firm_source_id: firmId,
		firm_name: firmName,
		firmName,
		firm_other_names: otherNames,
		otherNames,
		firm_bc_scope: toText(basicInformation.bcScope),
		bdSecNumber: toText(basicInformation.bdSECNumber) || null,
		iaSecNumber: toText(basicInformation.iaSECNumber) || null,
		disclosureFlag: detail.bdDisclosureFlag ?? detail.disclosureFlag ?? null,
		iaDisclosureFlag: detail.iaDisclosureFlag ?? null,
	};

	return {
		id: `${source}:firm:${firmId}`,
		type: 'firm',
		source,
		nameSearchText: nameTexts.join(' ').toLowerCase(),
		addressSearchText: currentAddressTexts.join(' ').toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(' ').toLowerCase(),
		searchText: uniqueTexts([firmId, ...nameTexts]).join(' ').toLowerCase(),
		hit,
	};
}

function getDetailRoot(bucket, payload) {
	if (!payload || typeof payload !== 'object') return null;
	if (bucket.source === 'finra') return payload.content && typeof payload.content === 'object' ? payload.content : null;
	if (bucket.source === 'sec') return payload.iacontent && typeof payload.iacontent === 'object' ? payload.iacontent : null;
	return null;
}

async function fileExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readBucketDocs(bucket) {
	let fileNames = [];
	try {
		fileNames = (await fs.readdir(bucket.dir)).filter((fileName) => bucket.filePattern.test(fileName)).sort();
	} catch {
		return { docs: null, generatedAt: null, reason: `source directory missing: ${bucket.dir}` };
	}

	if (!fileNames.length) {
		return { docs: null, generatedAt: null, reason: `no source files matched in ${bucket.dir}` };
	}

	const docs = [];
	let generatedAt = null;

	for (const fileName of fileNames) {
		try {
			const payload = JSON.parse(await fs.readFile(path.join(bucket.dir, fileName), 'utf8'));
			const detail = getDetailRoot(bucket, payload);
			if (!detail) continue;
			const doc =
				bucket.type === 'individual' ? buildIndividualDoc(bucket.source, detail)
				: buildFirmDoc(bucket.source, detail);
			if (!doc) continue;
			docs.push(doc);

			for (const value of [payload.generatedAt, payload.generated, detail.generatedAt, detail.generated]) {
				const text = toText(value);
				if (text && (!generatedAt || text > generatedAt)) generatedAt = text;
			}
		} catch (error) {
			console.warn(`Skipping malformed search-index source ${fileName}:`, error?.message || error);
		}
	}

	return { docs, generatedAt, reason: null };
}

async function writeBucket(bucket, docs, generatedAt) {
	const outputPath = path.join(NATIONAL_DIR, `search-index.${bucket.source}.${bucket.type}.json`);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(
		outputPath,
		JSON.stringify(
			{
				generatedAt: generatedAt || new Date().toISOString(),
				bucket: bucket.name,
				docs,
			},
			null,
			2,
		),
		'utf8',
	);
	return outputPath;
}

async function main() {
	let failures = 0;

	for (const bucket of BUCKETS) {
		const outputPath = path.join(NATIONAL_DIR, `search-index.${bucket.source}.${bucket.type}.json`);
		const { docs, generatedAt, reason } = await readBucketDocs(bucket);

		if (Array.isArray(docs) && docs.length) {
			await writeBucket(bucket, docs, generatedAt);
			console.log(`Built ${bucket.name} search index with ${docs.length} docs.`);
			continue;
		}

		if (await fileExists(outputPath)) {
			console.warn(`Preserving existing ${bucket.name} search index because ${reason || 'no docs were generated'}.`);
			continue;
		}

		failures += 1;
		console.error(`Missing ${bucket.name} search index output and unable to rebuild it (${reason || 'no docs were generated'}).`);
	}

	if (failures > 0) process.exit(1);
}

main().catch((error) => {
	console.error('build_search_indexes failed:', error);
	process.exit(1);
});
