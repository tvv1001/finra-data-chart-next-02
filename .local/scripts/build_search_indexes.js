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

// `next build` loads .env.local, but this script runs as a plain node process before it, so
// flags like USE_LOCAL_REDIS (which selects the local Redis detail cache as a sidecar source)
// were never visible here. Read them directly, without overriding real env vars.
function loadLocalEnvFlags() {
	const FLAGS = ['USE_LOCAL_REDIS', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
	try {
		const raw = require('node:fs').readFileSync(path.join(ROOT, '.env.local'), 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
			if (!match) continue;
			const [, key, rawValue] = match;
			if (!FLAGS.includes(key) || process.env[key] != null) continue;
			process.env[key] = rawValue.replace(/^["']|["']$/g, '');
		}
	} catch {
		/* no .env.local (CI/Vercel) — rely on the real environment */
	}
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

// Detail payloads arrive wrapped in a few different envelopes depending on which upstream
// endpoint/cache wrote them. Unwrap them all so every cached CRD produces a sidecar doc
// instead of being silently dropped (e.g. SEC firm records nested under
// `secInvestmentAdvisor` accounted for ~950 missing firms).
const DETAIL_WRAPPER_KEYS = ['finraBrokerCheck', 'secInvestmentAdvisor', 'secInvestmentAdviser'];

// Some cached payloads store the real detail as a JSON-serialized Node Buffer
// (`{ type: 'Buffer', data: [...] }`) whose bytes are themselves an encoded detail string.
function reviveBufferJson(value) {
	if (!value || typeof value !== 'object' || value.type !== 'Buffer' || !Array.isArray(value.data)) return null;
	try {
		return JSON.parse(decodeRedisValue(Buffer.from(value.data).toString('utf-8')));
	} catch {
		return null;
	}
}

function unwrapDetail(detail) {
	let current = detail;
	for (let depth = 0; depth < 6; depth += 1) {
		if (!current || typeof current !== 'object') return current;
		const revived = reviveBufferJson(current);
		if (revived) {
			current = revived;
			continue;
		}
		const wrapperKey = DETAIL_WRAPPER_KEYS.find((key) => current[key] && typeof current[key] === 'object');
		if (!wrapperKey) return current;
		const wrapped = reviveBufferJson(current[wrapperKey]) ?? current[wrapperKey];
		current = { ...current, ...wrapped };
		delete current[wrapperKey];
	}
	return current;
}

// A negative cache entry ("we asked upstream and there is no such record") must not be
// turned into an empty sidecar doc.
function isNegativeCacheDetail(detail) {
	return Boolean(detail && typeof detail === 'object' && detail.hits && typeof detail.hits === 'object' && Number(detail.hits.total) === 0);
}

// Some cached records only exist as "orphan" stubs discovered via a parent firm/person
// (no full BrokerCheck/AdviserInfo detail payload). They still carry a real CRD and often a
// real name, so they belong in the sidecar — that name/CRD pair is exactly what graph and
// dashboard label hydration look up.
function buildOrphanDoc(bucket, detail, fallbackId) {
	const orphan = detail && typeof detail === 'object' ? detail.orphan : null;
	if (!orphan || typeof orphan !== 'object') return null;
	const id = toText(orphan.crd ?? orphan.individualId ?? orphan.firmId ?? detail.crd ?? fallbackId);
	if (!id) return null;

	const address = orphan.officeAddress && typeof orphan.officeAddress === 'object' ? orphan.officeAddress : {};
	const addressTexts = uniqueTexts([address.street1, address.street2, address.city, address.state, address.country, address.postalCode]);

	if (bucket.type === 'individual') {
		const nameTexts = uniqueTexts([orphan.name, orphan.fullName, orphan.legalName]);
		const parts = toText(orphan.name).split(' ').filter(Boolean);
		const hit = {
			ind_source_id: id,
			ind_crd: id,
			ind_firstname: parts.length > 1 ? parts[0] : toText(orphan.name),
			ind_middlename: parts.length > 2 ? parts.slice(1, -1).join(' ') : '',
			ind_lastname: parts.length > 1 ? parts[parts.length - 1] : '',
			ind_other_names: [],
			otherNames: [],
			ind_current_employments: [],
			ind_ia_current_employments: [],
			ind_previous_employments: [],
			ind_ia_previous_employments: [],
			_orphanStub: true,
		};
		return {
			id: `${bucket.source}:individual:${id}`,
			type: 'individual',
			source: bucket.source,
			nameSearchText: nameTexts.join(' ').toLowerCase(),
			addressSearchText: addressTexts.join(' ').toLowerCase(),
			strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(' ').toLowerCase(),
			searchText: uniqueTexts([id, ...nameTexts]).join(' ').toLowerCase(),
			hit,
		};
	}

	const firmName = toText(orphan.firmName ?? orphan.name);
	const nameTexts = uniqueTexts([firmName]);
	const hit = {
		firm_id: id,
		firmId: id,
		firm_source_id: id,
		firm_name: firmName,
		firmName,
		firm_other_names: [],
		otherNames: [],
		_orphanStub: true,
	};
	return {
		id: `${bucket.source}:firm:${id}`,
		type: 'firm',
		source: bucket.source,
		nameSearchText: nameTexts.join(' ').toLowerCase(),
		addressSearchText: addressTexts.join(' ').toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(' ').toLowerCase(),
		searchText: uniqueTexts([id, ...nameTexts]).join(' ').toLowerCase(),
		hit,
	};
}

/** Build a sidecar doc from any supported cached payload shape. */
function buildDocFromDetail(bucket, rawDetail, fallbackId) {
	let detail = unwrapDetail(rawDetail);
	if (!detail || typeof detail !== 'object') return null;
	if (isNegativeCacheDetail(detail)) return null;
	// Unwrapping can expose a nested search envelope (e.g. a Buffer-encoded payload whose bytes
	// are a full `hits.hits[0]._source.content` response), so re-extract the detail root.
	if (detail.hits && !detail.basicInformation) {
		const nested = unwrapDetail(getDetailRoot(bucket, detail));
		if (nested && typeof nested === 'object') detail = nested;
	}
	const doc = bucket.type === 'individual' ? buildIndividualDoc(bucket.source, detail) : buildFirmDoc(bucket.source, detail);
	return doc || buildOrphanDoc(bucket, detail, fallbackId);
}

/** True when a doc carries a usable display name (not just a CRD). */
function docHasName(doc) {
	return Boolean(toText(doc?.nameSearchText));
}

// Merge doc lists into one per-id set. Sidecar consumers index by CRD first-wins
// (`getHitByIdMap` in src/lib/localSearch.ts), so a richer/named doc must always beat a
// bare stub for the same CRD.
function mergeDocLists(...docLists) {
	const byId = new Map();
	for (const docs of docLists) {
		for (const doc of docs || []) {
			if (!doc?.id) continue;
			const existing = byId.get(doc.id);
			if (!existing) {
				byId.set(doc.id, doc);
				continue;
			}
			if (!docHasName(existing) && docHasName(doc)) {
				byId.set(doc.id, doc);
				continue;
			}
			if (docHasName(existing) === docHasName(doc) && toText(doc.strictSearchText).length > toText(existing.strictSearchText).length) {
				byId.set(doc.id, doc);
			}
		}
	}
	return [...byId.values()];
}

function parseMaybeJson(value) {
	if (value && typeof value === 'object') return value;
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

// Cached source files nest the real payload under `hits.hits[0]._source.content` (FINRA) /
// `.iacontent` (SEC), and that field is a JSON *string*, not an object. The previous
// object-only, top-level lookup therefore never matched a single on-disk file, so the
// file-based build silently produced zero docs and every build fell through to "preserve
// the existing sidecar".
function getDetailRoot(bucket, payload) {
	if (!payload || typeof payload !== 'object') return null;
	const field = bucket.source === 'finra' ? 'content' : 'iacontent';
	const roots = [payload, payload?.hits?.hits?.[0]?._source];
	for (const root of roots) {
		if (!root || typeof root !== 'object') continue;
		const detail = parseMaybeJson(root[field]);
		if (detail) return detail;
	}
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

// Cached values come in three flavours: plain JSON, the app's `br:` + base64 brotli envelope
// (src/lib/redisCache.ts), and bare base64 brotli/gzip written by older importers. The
// bare-base64 variant used to fail JSON.parse and get skipped, dropping real CRD+name records
// from the sidecar, so try to decompress those too.
function decompressBase64(raw) {
	if (typeof raw !== 'string' || raw.length < 8 || /[^A-Za-z0-9+/=\r\n]/.test(raw)) return null;
	let buffer;
	try {
		buffer = Buffer.from(raw, 'base64');
	} catch {
		return null;
	}
	if (!buffer.length) return null;
	for (const decompress of [zlib.brotliDecompressSync, zlib.gunzipSync, zlib.inflateSync]) {
		try {
			return decompress(buffer).toString('utf-8');
		} catch {
			/* try the next codec */
		}
	}
	return null;
}

function decodeRedisValue(raw) {
	if (typeof raw !== 'string') return raw;
	// Some records were compressed twice (`br:` + base64-brotli of base64-brotli JSON) by an
	// older importer, so decode repeatedly until real JSON falls out instead of skipping the
	// entry — these carry real CRD + name records.
	let current = raw;
	for (let pass = 0; pass < 4; pass += 1) {
		const trimmed = current.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) return current;
		const candidate = trimmed.startsWith('br:') ? trimmed.slice(3) : trimmed;
		const decoded = decompressBase64(candidate);
		if (decoded == null) return current;
		current = decoded;
	}
	return current;
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
		// `KEYS finra:firm:*` also matches sidecar/companion keys such as
		// `sec:firm:summaryHtml:<id>`; restrict to true detail keys so those aren't parsed
		// as detail payloads.
		const detailKeyPattern = new RegExp(`^${bucket.redisPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`);
		const keys = (await redis.keys(`${bucket.redisPrefix}*`)).filter((key) => detailKeyPattern.test(key));
		if (!keys.length) return { docs: null, generatedAt: null, reason: `no keys found for ${bucket.redisPrefix}*` };

		const docs = [];
		const BATCH_SIZE = 500;
		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batchKeys = keys.slice(i, i + BATCH_SIZE);
			const values = await redis.mget(batchKeys);
			for (let j = 0; j < values.length; j += 1) {
				const rawValue = values[j];
				if (!rawValue) continue;
				const fallbackId = batchKeys[j].slice(bucket.redisPrefix.length);
				try {
					const decoded = decodeRedisValue(rawValue);
					const payload = JSON.parse(decoded);
					const source = payload?.hits?.hits?.[0]?._source || payload;
					let detail = null;

					// Extract the nested JSON string if it's wrapped in content/iacontent
					const detailField = bucket.source === 'finra' ? source?.content : source?.iacontent;
					if (typeof detailField === 'string') {
						try {
							detail = JSON.parse(detailField);
						} catch {}
					} else if (detailField && typeof detailField === 'object') {
						detail = detailField;
					} else {
						// It might be already un-stringified in the root, or wrapped in finraBrokerCheck
						detail = source;
					}

					const doc = buildDocFromDetail(bucket, detail, fallbackId);
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
			const detail = getDetailRoot(bucket, payload) || payload;
			const fallbackId = (fileName.match(/(\d+)\.json$/) || [])[1] || '';
			const doc = buildDocFromDetail(bucket, detail, fallbackId);
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
	loadLocalEnvFlags();
	let skippedBuckets = 0;
	const useLocalRedis = process.env.USE_LOCAL_REDIS === '1';

	for (const bucket of BUCKETS) {
		const outputPath = path.join(NATIONAL_DIR, `search-index.${bucket.source}.${bucket.type}.json`);
		const gzPath = `${outputPath}.gz`;
		let { docs, generatedAt, reason } = await readBucketDocs(bucket);

		// Union local Redis detail records with the file-based source instead of picking only
		// whichever produced more docs — each side holds CRDs the other lacks (the file cache
		// alone carried ~1,250 CRDs that the Redis-only build discarded). `mergeDocLists`
		// keeps the richer/named doc whenever both sides have the same CRD.
		if (useLocalRedis) {
			const redisResult = await readBucketDocsFromLocalRedis(bucket);
			if (Array.isArray(redisResult.docs) && redisResult.docs.length) {
				const fileDocs = Array.isArray(docs) ? docs : [];
				const merged = mergeDocLists(redisResult.docs, fileDocs);
				console.log(
					`Merged ${bucket.name}: ${redisResult.docs.length} local Redis docs + ${fileDocs.length} file docs → ${merged.length} unique docs.`,
				);
				docs = merged;
				generatedAt = redisResult.generatedAt || generatedAt;
				reason = null;
			} else if (redisResult.reason) {
				console.log(`Local Redis fallback skipped for ${bucket.name}: ${redisResult.reason}`);
			}
		}

		if (Array.isArray(docs) && docs.length) {
			docs = mergeDocLists(docs);
			const named = docs.filter(docHasName).length;
			await writeBucket(bucket, docs, generatedAt);
			console.log(`Built ${bucket.name} search index with ${docs.length} docs (${named} with labels) and gzipped sidecar.`);
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

module.exports = { buildIndividualDoc, buildFirmDoc, buildOrphanDoc, buildDocFromDetail, unwrapDetail, mergeDocLists, collectScalarTexts, uniqueTexts };
