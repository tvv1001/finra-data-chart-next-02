#!/usr/bin/env node
/**
 * Incrementally update local generated cache artifacts for specific raw files.
 *
 * Updates:
 * - canonical cache files in data/national/
 * - nested host mirrors in data/national/brokercheck.finra.org/ and adviserinfo.sec.gov/
 * - per-bucket search index files in data/national/search-index.*.json
 * - gzipped binary CRD cache entries in data/cache-binary/
 * - data/cache-binary/cache-manifest.json
 *
 * Usage:
 *   node scripts/update_local_cache.js --file finra:individual:4240769.json --file sec:firm:20.json
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const WORKSPACE_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';

function resolveDataDir() {
	const candidates = [WORKSPACE_DATA_DIR, process.env.FINRA_DATA_DIR].filter(Boolean).map((candidate) => path.resolve(candidate));
	for (const candidate of candidates) {
		try {
			if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory()) return candidate;
		} catch {}
	}
	return path.resolve(WORKSPACE_DATA_DIR);
}

const DATA_DIR = resolveDataDir();
const RAW_DIR = path.join(DATA_DIR, 'raw');
const NATIONAL_DIR = path.join(DATA_DIR, 'national');
const CACHE_BINARY_DIR = path.join(DATA_DIR, 'cache-binary');
const CACHE_BINARY_MANIFEST = path.join(CACHE_BINARY_DIR, 'cache-manifest.json');
const REPORT_PATH = path.join(NATIONAL_DIR, 'raw-append-report.json');
const HOST_DIRS = {
	finra: path.join(NATIONAL_DIR, 'brokercheck.finra.org'),
	sec: path.join(NATIONAL_DIR, 'adviserinfo.sec.gov'),
};
const SEARCH_INDEX_FILES = {
	'finra:individual': path.join(NATIONAL_DIR, 'search-index.finra.individual.json'),
	'finra:firm': path.join(NATIONAL_DIR, 'search-index.finra.firm.json'),
	'sec:individual': path.join(NATIONAL_DIR, 'search-index.sec.individual.json'),
	'sec:firm': path.join(NATIONAL_DIR, 'search-index.sec.firm.json'),
};

function parseArgs(argv) {
	const files = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--file' && argv[i + 1]) {
			files.push(argv[i + 1]);
			i += 1;
			continue;
		}
		if (arg.startsWith('--file=')) files.push(arg.slice('--file='.length));
	}
	return { files: Array.from(new Set(files.map((value) => String(value || '').trim()).filter(Boolean))) };
}

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeBuffer(filePath, value) {
	await ensureDir(path.dirname(filePath));
	await fs.writeFile(filePath, value);
}

function normalizeSource(rawSource) {
	const source = String(rawSource || '').toLowerCase();
	if (source === 'finra' || source === 'brokercheck') return 'finra';
	if (source === 'sec' || source === 'adviserinfo' || source === 'iapd') return 'sec';
	return null;
}

function parseRawFilename(rawName) {
	const match = String(rawName).match(/^([^:]+):(individual|firm):(.+)\.json$/i);
	if (!match) return null;
	const [, rawSource, rawType, rawId] = match;
	const source = normalizeSource(rawSource);
	if (!source) return null;
	const type = rawType.toLowerCase();
	const id = String(rawId).trim();
	if (!id) return null;
	const host = source === 'finra' ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
	const canonicalName = `api.${host}_search_${type}_${id}.json`;
	const cacheKey =
		source === 'finra' && type === 'individual' ? `finra:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`
		: source === 'sec' && type === 'individual' ? `sec:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`
		: source === 'finra' && type === 'firm' ? `finra:firm:${id}:${DEFAULT_FIRM_QUERY}`
		: `sec:firm:${id}`;
	return { source, type, id, host, canonicalName, cacheKey, rawName };
}

function normalizeText(value) {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function buildSearchText(parts) {
	return normalizeText(parts.filter(Boolean).join(' '));
}

function collectOtherNames(payload, basic = {}) {
	const values = [
		...(Array.isArray(payload?.otherNames) ? payload.otherNames : []),
		...(Array.isArray(payload?.other_names) ? payload.other_names : []),
		...(Array.isArray(basic?.otherNames) ? basic.otherNames : []),
		...(Array.isArray(basic?.other_names) ? basic.other_names : []),
	];
	return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function sanitizeBranchOffice(office) {
	if (!office || typeof office !== 'object') return null;
	return {
		city: office.city || null,
		state: office.state || null,
		street1: office.street1 || null,
		street2: office.street2 || null,
		zipCode: office.zipCode || null,
	};
}

function sanitizeEmployment(employment) {
	if (!employment || typeof employment !== 'object') return employment;
	const branchOffice = sanitizeBranchOffice(employment.branchOfficeLocations?.[0]);
	return {
		firmId: employment.firmId ?? employment.firm_id ?? null,
		firm_id: employment.firm_id ?? employment.firmId ?? null,
		firmName: employment.firmName || employment.firm_name || employment.organizationName || employment.legalName || null,
		firm_name: employment.firm_name || employment.firmName || employment.organizationName || employment.legalName || null,
		iaOnly: employment.iaOnly ?? null,
		registrationBeginDate: employment.registrationBeginDate || employment.startDate || employment.fromDate || null,
		registrationEndDate: employment.registrationEndDate || employment.endDate || employment.toDate || null,
		employmentStatus: employment.employmentStatus || employment.status || employment.currentStatus || null,
		firmBCScope: employment.firmBCScope || null,
		firmIAScope: employment.firmIAScope || null,
		bdSECNumber: employment.bdSECNumber ?? employment.firm_bd_sec_number ?? null,
		iaSECNumber: employment.iaSECNumber ?? employment.firm_ia_sec_number ?? null,
		city: employment.city || branchOffice?.city || null,
		state: employment.state || branchOffice?.state || null,
		zipCode: employment.zipCode || branchOffice?.zipCode || null,
		expelledDate: employment.expelledDate || null,
		branchOfficeLocations: branchOffice ? [branchOffice] : [],
	};
}

function buildIndividualSearchDoc(meta, payload) {
	const basic = payload?.basicInformation || {};
	const id = String(basic?.individualId || basic?.crd || meta?.id || '').trim();
	if (!id) return null;
	const firstName = basic?.firstName || payload?.firstName || '';
	const middleName = basic?.middleName || payload?.middleName || '';
	const lastName = basic?.lastName || payload?.lastName || '';
	const otherNames = collectOtherNames(payload, basic);
	const currentEmployments = Array.isArray(payload?.currentEmployments) ? payload.currentEmployments.map((employment) => sanitizeEmployment(employment)) : [];
	const currentIAEmployments = Array.isArray(payload?.currentIAEmployments) ? payload.currentIAEmployments.map((employment) => sanitizeEmployment(employment)) : [];
	const previousEmployments = Array.isArray(payload?.previousEmployments) ? payload.previousEmployments : [];
	const previousIAEmployments = Array.isArray(payload?.previousIAEmployments) ? payload.previousIAEmployments : [];
	const employmentNames = [...currentEmployments, ...currentIAEmployments, ...previousEmployments, ...previousIAEmployments].map(
		(employment) => employment?.firmName || employment?.firm_name || employment?.organizationName || '',
	);
	return {
		id: `${meta.source}:${meta.type}:${id}`,
		type: 'individual',
		source: meta.source,
		searchText: buildSearchText([id, firstName, middleName, lastName, ...otherNames, basic?.bcScope, basic?.iaScope, ...employmentNames]),
		hit: {
			ind_source_id: id,
			ind_crd: id,
			ind_firstname: firstName,
			ind_middlename: middleName,
			ind_lastname: lastName,
			ind_other_names: otherNames,
			otherNames,
			ind_bc_scope: basic?.bcScope ?? payload?.bcScope ?? null,
			ind_ia_scope: basic?.iaScope ?? payload?.iaScope ?? null,
			ind_approved_finra_registration_count: payload?.registrationCount?.approvedFinraRegistrationCount ?? 0,
			ind_approved_sro_registration_count: payload?.registrationCount?.approvedSRORegistrationCount ?? 0,
			ind_approved_state_registration_count: payload?.registrationCount?.approvedStateRegistrationCount ?? 0,
			ind_approved_ia_state_registration_count: payload?.registrationCount?.approvedIAStateRegistrationCount ?? 0,
			ind_current_employments: currentEmployments,
			ind_ia_current_employments: currentIAEmployments,
			disclosureFlag: payload?.disclosureFlag ?? basic?.disclosureFlag ?? null,
			iaDisclosureFlag: payload?.iaDisclosureFlag ?? basic?.iaDisclosureFlag ?? null,
		},
	};
}

function buildFirmSearchDoc(meta, payload) {
	const basic = payload?.basicInformation || {};
	const id = String(basic?.firmId || payload?.firmId || meta?.id || '').trim();
	if (!id) return null;
	const firmName = String(basic?.firmName || payload?.firmName || payload?.name || '').trim();
	const otherNames = collectOtherNames(payload, basic);
	return {
		id: `${meta.source}:${meta.type}:${id}`,
		type: 'firm',
		source: meta.source,
		searchText: buildSearchText([id, firmName, ...otherNames, basic?.bdSECNumber, basic?.bdSecNumber, basic?.iaSECNumber, basic?.iaSecNumber, basic?.bcScope, basic?.firmStatus]),
		hit: {
			firm_id: id,
			firmId: id,
			firm_source_id: id,
			firm_name: firmName || `Firm ${id}`,
			firmName: firmName || `Firm ${id}`,
			firm_other_names: otherNames,
			otherNames,
			firm_bc_scope: basic?.bcScope ?? payload?.bcScope ?? null,
			bdSecNumber: basic?.bdSECNumber ?? basic?.bdSecNumber ?? payload?.bdSECNumber ?? payload?.bdSecNumber ?? null,
			iaSecNumber: basic?.iaSECNumber ?? basic?.iaSecNumber ?? payload?.iaSECNumber ?? payload?.iaSecNumber ?? null,
			disclosureFlag: payload?.disclosureFlag ?? basic?.disclosureFlag ?? null,
			iaDisclosureFlag: payload?.iaDisclosureFlag ?? basic?.iaDisclosureFlag ?? null,
		},
	};
}

function buildSearchDoc(meta, payload) {
	return meta.type === 'individual' ? buildIndividualSearchDoc(meta, payload) : buildFirmSearchDoc(meta, payload);
}

function parseSearchIndexDocs(json) {
	if (Array.isArray(json)) return json;
	if (Array.isArray(json?.docs)) return json.docs;
	return [];
}

async function loadSearchIndexMap(bucketKey) {
	const filePath = SEARCH_INDEX_FILES[bucketKey];
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		const docs = parseSearchIndexDocs(JSON.parse(raw));
		return new Map(docs.map((doc) => [String(doc.id), doc]));
	} catch {
		return new Map();
	}
}

async function writeSearchIndexMap(bucketKey, map) {
	const docs = Array.from(map.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
	await writeJson(SEARCH_INDEX_FILES[bucketKey], {
		generatedAt: new Date().toISOString(),
		bucket: bucketKey,
		docs,
	});
}

function getBinaryFilePaths(cacheKey) {
	const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
	return {
		hash,
		dataPath: path.join(CACHE_BINARY_DIR, `${hash}.bin`),
		metaPath: path.join(CACHE_BINARY_DIR, `${hash}.json`),
	};
}

async function writeStructuredBinaryCache(cacheKey, value, metadata = {}) {
	await ensureDir(CACHE_BINARY_DIR);
	const { hash, dataPath, metaPath } = getBinaryFilePaths(cacheKey);
	const json = JSON.stringify(value);
	const gzip = zlib.gzipSync(Buffer.from(json, 'utf8'));
	const expiresAt = Date.now() + 3650 * 24 * 60 * 60 * 1000;
	await Promise.all([
		writeBuffer(dataPath, gzip),
		writeJson(metaPath, {
			expiresAt,
			kind: 'json-gzip-v1',
			key: cacheKey,
			updatedAt: new Date().toISOString(),
			...metadata,
		}),
	]);
	return { hash, bytes: gzip.length };
}

async function loadBinaryManifest() {
	try {
		const raw = await fs.readFile(CACHE_BINARY_MANIFEST, 'utf8');
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
		return new Map(entries.map((entry) => [String(entry.key), entry]));
	} catch {
		return new Map();
	}
}

async function writeBinaryManifest(entriesMap) {
	const entries = Array.from(entriesMap.values()).sort((a, b) => String(a.key).localeCompare(String(b.key)));
	await writeJson(CACHE_BINARY_MANIFEST, { generatedAt: new Date().toISOString(), entries });
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options.files.length) {
		console.error('No raw files provided. Use --file <rawName>.');
		process.exit(1);
	}

	await Promise.all([ensureDir(NATIONAL_DIR), ensureDir(CACHE_BINARY_DIR), ...Object.values(HOST_DIRS).map((dir) => ensureDir(dir))]);

	const searchIndexMaps = {
		'finra:individual': await loadSearchIndexMap('finra:individual'),
		'finra:firm': await loadSearchIndexMap('finra:firm'),
		'sec:individual': await loadSearchIndexMap('sec:individual'),
		'sec:firm': await loadSearchIndexMap('sec:firm'),
	};
	const binaryManifest = await loadBinaryManifest();
	const updated = [];
	const skipped = [];

	for (const rawName of options.files) {
		const meta = parseRawFilename(rawName);
		if (!meta) {
			skipped.push({ rawName, reason: 'unsupported filename pattern' });
			continue;
		}
		const srcPath = path.join(RAW_DIR, rawName);
		let raw;
		let parsed;
		try {
			raw = await fs.readFile(srcPath, 'utf8');
			parsed = JSON.parse(raw);
		} catch (error) {
			skipped.push({ rawName, reason: error?.message || 'failed to read raw file' });
			continue;
		}

		const canonicalPath = path.join(NATIONAL_DIR, meta.canonicalName);
		const hostPath = path.join(HOST_DIRS[meta.source], meta.canonicalName);
		await Promise.all([fs.writeFile(canonicalPath, raw, 'utf8'), fs.writeFile(hostPath, raw, 'utf8')]);

		const payload = parsed?.content || parsed?.iacontent || parsed;
		const searchDoc = buildSearchDoc(meta, payload);
		if (searchDoc) searchIndexMaps[`${meta.source}:${meta.type}`].set(String(searchDoc.id), searchDoc);

		const binaryInfo = await writeStructuredBinaryCache(meta.cacheKey, parsed, {
			source: meta.source,
			type: meta.type,
			id: meta.id,
			rawName: meta.rawName,
			canonicalName: meta.canonicalName,
		});
		binaryManifest.set(meta.cacheKey, {
			key: meta.cacheKey,
			hash: binaryInfo.hash,
			source: meta.source,
			type: meta.type,
			id: meta.id,
			rawName: meta.rawName,
			canonicalName: meta.canonicalName,
			bytes: binaryInfo.bytes,
		});
		updated.push({ rawName, cacheKey: meta.cacheKey, canonicalName: meta.canonicalName, hash: binaryInfo.hash, bytes: binaryInfo.bytes });
	}

	await Promise.all([
		writeSearchIndexMap('finra:individual', searchIndexMaps['finra:individual']),
		writeSearchIndexMap('finra:firm', searchIndexMaps['finra:firm']),
		writeSearchIndexMap('sec:individual', searchIndexMaps['sec:individual']),
		writeSearchIndexMap('sec:firm', searchIndexMaps['sec:firm']),
		writeBinaryManifest(binaryManifest),
		writeJson(REPORT_PATH, {
			generatedAt: new Date().toISOString(),
			updated,
			skipped,
			count: updated.length,
		}),
	]);

	console.log(`Updated local cache entries: ${updated.length}`);
	if (skipped.length) console.log(`Skipped: ${skipped.length}`);
	console.log(`Append report: ${REPORT_PATH}`);
}

main().catch((error) => {
	console.error(error?.message || error);
	process.exit(1);
});
