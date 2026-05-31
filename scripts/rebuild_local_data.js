#!/usr/bin/env node
/**
 * Rebuild local data cache from raw FINRA / SEC payloads.
 *
 * Outputs:
 * - canonical cache files in data/national/
 * - nested host mirrors in data/national/brokercheck.finra.org/ and adviserinfo.sec.gov/
 * - primed bundle JSON + gzip binaries in both:
 *   - data/national/primed-cache/
 *   - data/primed-cache/ (compat for older loaders)
 * - validation / inventory manifests in data/national/
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const WORKSPACE_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';
const MAIN_BUNDLE_FILES = ['finra-individual', 'sec-individual', 'finra-firm', 'sec-firm'];

function resolveDataDir() {
	const candidates = [WORKSPACE_DATA_DIR, process.env.FINRA_DATA_DIR].filter(Boolean).map((candidate) => path.resolve(candidate));

	for (const candidate of candidates) {
		try {
			if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory()) {
				return candidate;
			}
		} catch {
			// ignore and continue
		}
	}

	return path.resolve(WORKSPACE_DATA_DIR);
}

const DATA_DIR = resolveDataDir();
const RAW_DIR = path.join(DATA_DIR, 'raw');
const NATIONAL_DIR = path.join(DATA_DIR, 'national');
const CACHE_BINARY_DIR = path.join(DATA_DIR, 'cache-binary');
const HOST_DIRS = {
	finra: path.join(NATIONAL_DIR, 'brokercheck.finra.org'),
	sec: path.join(NATIONAL_DIR, 'adviserinfo.sec.gov'),
};
const PRIMED_CACHE_DIRS = [path.join(NATIONAL_DIR, 'primed-cache'), path.join(DATA_DIR, 'primed-cache')];
const GENERATED_MANIFEST = path.join(NATIONAL_DIR, 'rebuild-manifest.json');
const GENERATED_VALIDATION = path.join(NATIONAL_DIR, 'rebuild-validation.json');
const CACHE_BINARY_MANIFEST = path.join(CACHE_BINARY_DIR, 'cache-manifest.json');
const SEARCH_INDEX_FILES = {
	'finra:individual': path.join(NATIONAL_DIR, 'search-index.finra.individual.json'),
	'finra:firm': path.join(NATIONAL_DIR, 'search-index.finra.firm.json'),
	'sec:individual': path.join(NATIONAL_DIR, 'search-index.sec.individual.json'),
	'sec:firm': path.join(NATIONAL_DIR, 'search-index.sec.firm.json'),
};

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

async function removeIfExists(filePath) {
	try {
		await fs.rm(filePath, { force: true, recursive: true });
	} catch {
		// ignore
	}
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
	const bundleName = `${source}-${type}`;
	const cacheKey =
		source === 'finra' && type === 'individual' ? `finra:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`
		: source === 'sec' && type === 'individual' ? `sec:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`
		: source === 'finra' && type === 'firm' ? `finra:firm:${id}:${DEFAULT_FIRM_QUERY}`
		: `sec:firm:${id}`;

	return { source, type, id, host, canonicalName, bundleName, cacheKey, rawName };
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
	const meta = {
		expiresAt,
		kind: 'json-gzip-v1',
		key: cacheKey,
		updatedAt: new Date().toISOString(),
		...metadata,
	};
	await Promise.all([writeBuffer(dataPath, gzip), writeJson(metaPath, meta)]);
	return { hash, dataPath, metaPath, bytes: gzip.length };
}

async function cleanGeneratedOutputs() {
	await ensureDir(NATIONAL_DIR);
	await ensureDir(CACHE_BINARY_DIR);
	await Promise.all(Object.values(HOST_DIRS).map((dir) => ensureDir(dir)));
	await Promise.all(PRIMED_CACHE_DIRS.map((dir) => ensureDir(dir)));

	const nationalEntries = await fs.readdir(NATIONAL_DIR, { withFileTypes: true }).catch(() => []);
	for (const entry of nationalEntries) {
		if (!entry.isFile()) continue;
		if (/^api\.(brokercheck\.finra\.org|adviserinfo\.sec\.gov)_search_(individual|firm)_.+\.json$/i.test(entry.name)) {
			await removeIfExists(path.join(NATIONAL_DIR, entry.name));
		}
	}

	for (const hostDir of Object.values(HOST_DIRS)) {
		const hostEntries = await fs.readdir(hostDir, { withFileTypes: true }).catch(() => []);
		for (const entry of hostEntries) {
			if (!entry.isFile()) continue;
			if (/^api\.(brokercheck\.finra\.org|adviserinfo\.sec\.gov)_search_(individual|firm)_.+\.json$/i.test(entry.name)) {
				await removeIfExists(path.join(hostDir, entry.name));
			}
		}
	}

	for (const dir of PRIMED_CACHE_DIRS) {
		for (const name of MAIN_BUNDLE_FILES) {
			await removeIfExists(path.join(dir, `${name}.json`));
			await removeIfExists(path.join(dir, `${name}.bin`));
		}
	}

	for (const filePath of Object.values(SEARCH_INDEX_FILES)) {
		await removeIfExists(filePath);
	}

	const binaryEntries = await fs.readdir(CACHE_BINARY_DIR, { withFileTypes: true }).catch(() => []);
	for (const entry of binaryEntries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith('.bin') && !entry.name.endsWith('.json')) continue;
		await removeIfExists(path.join(CACHE_BINARY_DIR, entry.name));
	}

	await removeIfExists(GENERATED_MANIFEST);
	await removeIfExists(GENERATED_VALIDATION);
	await removeIfExists(CACHE_BINARY_MANIFEST);
}

async function writeJson(filePath, value) {
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeBuffer(filePath, value) {
	await fs.writeFile(filePath, value);
}

async function run() {
	console.log(`Rebuilding local data cache from ${RAW_DIR}`);
	console.log(`Using data directory ${DATA_DIR}`);

	await cleanGeneratedOutputs();

	let files;
	try {
		files = (await fs.readdir(RAW_DIR)).filter((file) => file.toLowerCase().endsWith('.json')).sort();
	} catch (error) {
		console.error(`Failed to read raw directory ${RAW_DIR}: ${error.message}`);
		process.exit(1);
	}

	const bundles = {
		'finra-individual': {},
		'sec-individual': {},
		'finra-firm': {},
		'sec-firm': {},
	};
	const searchIndexBuckets = {
		'finra:individual': [],
		'finra:firm': [],
		'sec:individual': [],
		'sec:firm': [],
	};
	const counts = {
		rawFiles: files.length,
		processed: 0,
		unsupportedNames: 0,
		invalidJson: 0,
		duplicateCanonicalFiles: 0,
		duplicateBundleKeys: 0,
	};
	const sourceCounts = {
		finra: { individual: 0, firm: 0 },
		sec: { individual: 0, firm: 0 },
	};
	const binaryCacheEntries = [];
	const skipped = [];
	const invalidFiles = [];
	const duplicates = [];
	const seenCanonical = new Map();
	const seenBundleKeys = new Map();

	for (const file of files) {
		const meta = parseRawFilename(file);
		if (!meta) {
			counts.unsupportedNames += 1;
			skipped.push({ file, reason: 'unsupported filename pattern' });
			continue;
		}

		const srcPath = path.join(RAW_DIR, file);
		let raw;
		let parsed;
		try {
			raw = await fs.readFile(srcPath, 'utf8');
			parsed = JSON.parse(raw);
		} catch (error) {
			counts.invalidJson += 1;
			invalidFiles.push({ file, error: error.message });
			continue;
		}

		const canonicalPath = path.join(NATIONAL_DIR, meta.canonicalName);
		const hostPath = path.join(HOST_DIRS[meta.source], meta.canonicalName);

		if (seenCanonical.has(meta.canonicalName)) {
			counts.duplicateCanonicalFiles += 1;
			duplicates.push({
				type: 'canonical-file',
				key: meta.canonicalName,
				previous: seenCanonical.get(meta.canonicalName),
				current: file,
			});
		}
		seenCanonical.set(meta.canonicalName, file);

		if (seenBundleKeys.has(meta.cacheKey)) {
			counts.duplicateBundleKeys += 1;
			duplicates.push({
				type: 'bundle-key',
				key: meta.cacheKey,
				previous: seenBundleKeys.get(meta.cacheKey),
				current: file,
			});
		}
		seenBundleKeys.set(meta.cacheKey, file);

		await Promise.all([fs.writeFile(canonicalPath, raw, 'utf8'), fs.writeFile(hostPath, raw, 'utf8')]);
		bundles[meta.bundleName][meta.cacheKey] = parsed;
		const payload = parsed?.content || parsed?.iacontent || parsed;
		const searchDoc = buildSearchDoc(meta, payload);
		if (searchDoc) searchIndexBuckets[`${meta.source}:${meta.type}`].push(searchDoc);
		const binaryInfo = await writeStructuredBinaryCache(meta.cacheKey, parsed, {
			source: meta.source,
			type: meta.type,
			id: meta.id,
			rawName: meta.rawName,
			canonicalName: meta.canonicalName,
		});
		binaryCacheEntries.push({
			key: meta.cacheKey,
			hash: binaryInfo.hash,
			source: meta.source,
			type: meta.type,
			id: meta.id,
			rawName: meta.rawName,
			canonicalName: meta.canonicalName,
			bytes: binaryInfo.bytes,
		});
		sourceCounts[meta.source][meta.type] += 1;
		counts.processed += 1;
	}

	const bundleStats = {};
	for (const [bundleName, bundle] of Object.entries(bundles)) {
		const json = `${JSON.stringify(bundle, null, 2)}\n`;
		const gzip = zlib.gzipSync(Buffer.from(json, 'utf8'));
		bundleStats[bundleName] = {
			entries: Object.keys(bundle).length,
			jsonBytes: Buffer.byteLength(json),
			gzipBytes: gzip.length,
		};

		for (const dir of PRIMED_CACHE_DIRS) {
			await Promise.all([writeJson(path.join(dir, `${bundleName}.json`), bundle), writeBuffer(path.join(dir, `${bundleName}.bin`), gzip)]);
		}
	}

	const searchIndexStats = {};
	for (const [bucketKey, docs] of Object.entries(searchIndexBuckets)) {
		const filePath = SEARCH_INDEX_FILES[bucketKey];
		const payload = {
			generatedAt: new Date().toISOString(),
			bucket: bucketKey,
			docs,
		};
		const json = `${JSON.stringify(payload)}\n`;
		await fs.writeFile(filePath, json, 'utf8');
		searchIndexStats[bucketKey] = {
			entries: docs.length,
			jsonBytes: Buffer.byteLength(json),
			file: filePath,
		};
	}

	const manifest = {
		generatedAt: new Date().toISOString(),
		dataDir: DATA_DIR,
		rawDir: RAW_DIR,
		nationalDir: NATIONAL_DIR,
		hostDirs: HOST_DIRS,
		primedCacheDirs: PRIMED_CACHE_DIRS,
		counts,
		sourceCounts,
		bundleStats,
		searchIndexStats,
		binaryCache: {
			dir: CACHE_BINARY_DIR,
			manifest: CACHE_BINARY_MANIFEST,
			entries: binaryCacheEntries.length,
			bytes: binaryCacheEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0),
		},
	};

	const validation = {
		generatedAt: manifest.generatedAt,
		skipped,
		invalidFiles,
		duplicates,
	};

	await Promise.all([
		writeJson(GENERATED_MANIFEST, manifest),
		writeJson(GENERATED_VALIDATION, validation),
		writeJson(CACHE_BINARY_MANIFEST, { generatedAt: manifest.generatedAt, entries: binaryCacheEntries }),
	]);

	console.log('Rebuild complete.');
	console.log(`  Processed: ${counts.processed}/${counts.rawFiles}`);
	console.log(`  FINRA  -> individuals: ${sourceCounts.finra.individual}, firms: ${sourceCounts.finra.firm}`);
	console.log(`  SEC    -> individuals: ${sourceCounts.sec.individual}, firms: ${sourceCounts.sec.firm}`);
	for (const [bundleName, stat] of Object.entries(bundleStats)) {
		console.log(`  Bundle ${bundleName}: ${stat.entries} entries (${stat.jsonBytes} bytes json, ${stat.gzipBytes} bytes gzip)`);
	}
	console.log(`  Binary cache entries: ${binaryCacheEntries.length}`);
	if (skipped.length || invalidFiles.length || duplicates.length) {
		console.log(`  Validation warnings: skipped=${skipped.length}, invalid=${invalidFiles.length}, duplicates=${duplicates.length}`);
		console.log(`  See ${GENERATED_VALIDATION}`);
	}
	console.log(`  Manifest written to ${GENERATED_MANIFEST}`);
}

if (require.main === module) {
	run().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
