#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = process.cwd();
const NATIONAL_DIR = path.join(ROOT, 'data', 'national');
const FINRA_DIR = path.join(NATIONAL_DIR, 'brokercheck.finra.org');
const SEC_DIR = path.join(NATIONAL_DIR, 'adviserinfo.sec.gov');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const BUCKETS = [
	{
		name: 'finra:individual',
		source: 'finra',
		type: 'individual',
		dir: FINRA_DIR,
		filePattern: /^(?:api\.brokercheck\.finra\.org_search_individual_|finra:individual:)\d+\.json$/,
		redisPrefix: 'finra:individual:',
	},
	{
		name: 'finra:firm',
		source: 'finra',
		type: 'firm',
		dir: FINRA_DIR,
		filePattern: /^(?:api\.brokercheck\.finra\.org_search_firm_|finra:firm:)\d+\.json$/,
		redisPrefix: 'finra:firm:',
	},
	{
		name: 'sec:individual',
		source: 'sec',
		type: 'individual',
		dir: SEC_DIR,
		filePattern: /^(?:api\.adviserinfo\.sec\.gov_search_individual_|sec:individual:)\d+\.json$/,
		redisPrefix: 'sec:individual:',
	},
	{
		name: 'sec:firm',
		source: 'sec',
		type: 'firm',
		dir: SEC_DIR,
		filePattern: /^(?:api\.adviserinfo\.sec\.gov_search_firm_|sec:firm:)\d+\.json$/,
		redisPrefix: 'sec:firm:',
	},
];

function isValidUpstashUrl(value) {
	return typeof value === 'string' && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes('...');
}

function canFallbackToRedis() {
	return Boolean(REDIS_TOKEN) && isValidUpstashUrl(REDIS_URL);
}

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
	const previousEmployments = normalizeEmployments(detail.previousEmployments);
	const previousIAEmployments = normalizeEmployments(detail.previousIAEmployments);
	const firmIds = uniqueTexts([...currentEmployments.map((e) => e.firmId), ...currentIAEmployments.map((e) => e.firmId), ...previousEmployments.map((e) => e.firmId), ...previousIAEmployments.map((e) => e.firmId)]);
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
		ind_previous_employments: previousEmployments,
		ind_ia_previous_employments: previousIAEmployments,
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
		searchText: uniqueTexts([individualId, ...nameTexts, ...firmIds])
			.join(' ')
			.toLowerCase(),
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
		searchText: uniqueTexts([firmId, ...nameTexts])
			.join(' ')
			.toLowerCase(),
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

function decodeRedisValue(raw) {
	if (typeof raw !== 'string') return raw;
	if (raw.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(raw.slice(3), 'base64')).toString('utf-8');
		} catch {
			return raw;
		}
	}
	return raw;
}

// Rebuild the search-index sidecar from the same detail records the local Redis cache holds
// (finra:individual:<crd>, finra:firm:<crd>, sec:individual:<crd>, sec:firm:<crd>) so the
// dashboard/graph search sidecar carries real address/employment data instead of label-only
// stubs. This mirrors the shape `getDetailRoot`/`buildIndividualDoc`/`buildFirmDoc` expect
// (payload.content for finra, payload.iacontent for sec).
async function readBucketDocsFromLocalRedis(bucket) {
	let IORedis;
	try {
		IORedis = require('ioredis');
	} catch {
		return { docs: null, generatedAt: null, reason: 'ioredis module not available' };
	}

	const redis = new IORedis('redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
	try {
		await redis.connect();
	} catch (error) {
		return { docs: null, generatedAt: null, reason: `local Redis unavailable: ${error?.message || error}` };
	}

	try {
		const keys = await redis.keys(`${bucket.redisPrefix}*`);
		if (!keys.length) return { docs: null, generatedAt: null, reason: `no keys found for ${bucket.redisPrefix}*` };

		const docs = [];
		const BATCH_SIZE = 500;
		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batchKeys = keys.slice(i, i + BATCH_SIZE);
			const values = await redis.mget(batchKeys);
			for (const rawValue of values) {
				if (!rawValue) continue;
				try {
					const decoded = decodeRedisValue(rawValue);
					const payload = JSON.parse(decoded);
					const source = payload?.hits?.hits?.[0]?._source || payload;
					const detailField = bucket.source === 'finra' ? source?.content : source?.iacontent;
					const detail = typeof detailField === 'string' ? JSON.parse(detailField) : detailField && typeof detailField === 'object' ? detailField : null;
					if (!detail) continue;
					const doc = bucket.type === 'individual' ? buildIndividualDoc(bucket.source, detail) : buildFirmDoc(bucket.source, detail);
					if (doc) docs.push(doc);
				} catch {
					// skip malformed cache entries
				}
			}
		}

		return { docs, generatedAt: new Date().toISOString(), reason: null };
	} finally {
		redis.disconnect();
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
			const doc = bucket.type === 'individual' ? buildIndividualDoc(bucket.source, detail) : buildFirmDoc(bucket.source, detail);
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
	const gzPath = `${outputPath}.gz`;
	const gzBuffer = zlib.gzipSync(await fs.readFile(outputPath), { level: 9 });
	await fs.writeFile(gzPath, gzBuffer);
	return outputPath;
}

async function gzipExistingBucket(outputPath) {
	const gzPath = `${outputPath}.gz`;
	const raw = await fs.readFile(outputPath);
	const gzBuffer = zlib.gzipSync(raw, { level: 9 });
	await fs.writeFile(gzPath, gzBuffer);
	return gzPath;
}

async function main() {
	let skippedBuckets = 0;
	const useLocalRedis = process.env.USE_LOCAL_REDIS === '1';

	for (const bucket of BUCKETS) {
		const outputPath = path.join(NATIONAL_DIR, `search-index.${bucket.source}.${bucket.type}.json`);
		const gzPath = `${outputPath}.gz`;
		let { docs, generatedAt, reason } = await readBucketDocs(bucket);

		// Prefer local Redis detail records over file-based/stub docs when running against
		// the local dev cache — local Redis holds full detail payloads (address/employment
		// data) mirroring what the same search sidecar gets in production, whereas the
		// file-based source directories may only contain minimal label-only stubs.
		if (useLocalRedis) {
			const redisResult = await readBucketDocsFromLocalRedis(bucket);
			if (Array.isArray(redisResult.docs) && redisResult.docs.length > (docs?.length || 0)) {
				docs = redisResult.docs;
				generatedAt = redisResult.generatedAt;
				reason = null;
				console.log(`Using local Redis detail records for ${bucket.name} (${docs.length} docs) instead of file-based source.`);
			} else if (redisResult.reason) {
				console.log(`Local Redis fallback skipped for ${bucket.name}: ${redisResult.reason}`);
			}
		}

		if (Array.isArray(docs) && docs.length) {
			await writeBucket(bucket, docs, generatedAt);
			console.log(`Built ${bucket.name} search index with ${docs.length} docs and gzipped sidecar.`);
			continue;
		}

		if (await fileExists(outputPath)) {
			await gzipExistingBucket(outputPath);
			console.log(`Preserved ${bucket.name} search index and refreshed gzipped sidecar because ${reason || 'no docs were generated'}.`);
			continue;
		}

		if (await fileExists(gzPath)) {
			console.log(`Preserved ${bucket.name} gzipped search index because ${reason || 'no docs were generated'}; raw source is not available in this build environment.`);
			continue;
		}

		skippedBuckets += 1;
		const reasonText = reason || 'no docs were generated';
		if (canFallbackToRedis()) {
			console.warn(`Skipping ${bucket.name} local search index output because ${reasonText}; runtime search can fall back to Redis.`);
			continue;
		}

		console.warn(`Skipping ${bucket.name} local search index output because ${reasonText}; runtime search will rely on available local or remote data sources.`);
	}

	if (skippedBuckets > 0) {
		console.log(`Search index build completed with ${skippedBuckets} skipped bucket(s) because source data was unavailable in this environment.`);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error('build_search_indexes failed:', error);
		process.exit(1);
	});
}

module.exports = { buildIndividualDoc, buildFirmDoc, collectScalarTexts, uniqueTexts };
