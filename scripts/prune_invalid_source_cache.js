#!/usr/bin/env node
const { Redis } = require('@upstash/redis');
const argv = require('minimist')(process.argv.slice(2));

const APPLY = argv.apply === true || argv.a === true;
const COUNT = Math.max(100, Number(argv.count || 500));
const MAX_KEYS = Math.max(1, Number(argv.maxKeys || 500000));
const PATTERNS = ['finra:individual:*', 'sec:individual:*', 'finra:firm:*', 'sec:firm:*'];

function normalizeScopeValue(value) {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
}

function isNotInScopeValue(value) {
	return normalizeScopeValue(value) === 'notinscope';
}

function isInScopeValue(value) {
	const normalized = normalizeScopeValue(value);
	return Boolean(normalized) && normalized !== 'notinscope';
}

function isPlainObject(value) {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseRawValue(raw) {
	if (raw == null) return null;
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}
	return raw;
}

function parseEmbeddedContent(source, keys = ['content', 'iacontent']) {
	if (!isPlainObject(source)) return null;
	for (const key of keys) {
		const raw = source[key];
		if (!raw) continue;
		if (isPlainObject(raw)) return raw;
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				if (isPlainObject(parsed)) return parsed;
			} catch {
				return null;
			}
		}
	}
	return null;
}

function getEntityFromKey(key) {
	const match = /^(finra|sec):(individual|firm):(\d{1,10}|8-\d+)/i.exec(String(key || '').trim());
	if (!match) return null;
	return { source: match[1].toLowerCase(), entity: match[2].toLowerCase(), id: match[3] };
}

function buildIndividualStub(source) {
	const embedded = parseEmbeddedContent(source);
	if (embedded) {
		return {
			detail: { ...source, ...embedded },
			searchHitOnly: false,
		};
	}
	return {
		detail: {
			bcScope: source.ind_bc_scope ?? source.bcScope ?? null,
			iaScope: source.ind_ia_scope ?? source.iaScope ?? null,
			registrationCount: {
				approvedFinraRegistrationCount: Number(source.ind_approved_finra_registration_count || 0) || 0,
				approvedSRORegistrationCount: Number(source.ind_approved_sro_registration_count || 0) || 0,
				approvedIAStateRegistrationCount: Number(source.ind_approved_ia_state_registration_count || 0) || 0,
			},
			currentEmployments: [],
			previousEmployments: [],
			currentIAEmployments: [],
			previousIAEmployments: [],
			_searchHitOnly: true,
		},
		searchHitOnly: true,
	};
}

function buildFirmStub(source) {
	const embedded = parseEmbeddedContent(source);
	if (embedded) {
		return {
			detail: { ...source, ...embedded },
			searchHitOnly: false,
		};
	}
	return {
		detail: {
			bcScope: source.firm_bc_scope ?? source.bcScope ?? null,
			iaScope: source.firm_ia_scope ?? source.iaScope ?? null,
			_searchHitOnly: true,
		},
		searchHitOnly: true,
	};
}

function hasIndividualCoverage(detail, source) {
	if (!isPlainObject(detail)) return false;
	const scope = source === 'finra' ? detail.bcScope : detail.iaScope;
	if (isNotInScopeValue(scope)) return false;
	if (isInScopeValue(scope)) return true;
	const reg = isPlainObject(detail.registrationCount) ? detail.registrationCount : {};
	if (source === 'finra') {
		if (Number(reg.approvedFinraRegistrationCount || 0) > 0) return true;
		if (Number(reg.approvedSRORegistrationCount || 0) > 0) return true;
		if (Array.isArray(detail.currentEmployments) && detail.currentEmployments.length > 0) return true;
		if (Array.isArray(detail.previousEmployments) && detail.previousEmployments.length > 0) return true;
		return false;
	}
	if (Number(reg.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (Array.isArray(detail.currentIAEmployments) && detail.currentIAEmployments.length > 0) return true;
	if (Array.isArray(detail.previousIAEmployments) && detail.previousIAEmployments.length > 0) return true;
	return false;
}

function hasFirmCoverage(detail, source) {
	if (!isPlainObject(detail)) return false;
	const scope = source === 'finra' ? detail.bcScope : detail.iaScope;
	if (isNotInScopeValue(scope)) return false;
	if (isInScopeValue(scope)) return true;
	if (source === 'finra') {
		return Boolean(String(detail.bdSECNumber || detail.bdSecNumber || detail.districtName || '').trim());
	}
	return Boolean(String(detail.iaSECNumber || detail.iaSecNumber || '').trim());
}

function isOrphanPayload(source) {
	if (!isPlainObject(source) || !isPlainObject(source.orphan)) return false;
	const sources = source.sources;
	return isPlainObject(sources) && sources.finra?.found === false && sources.sec?.found === false;
}

function classifyPayload(key, payload) {
	const parsedKey = getEntityFromKey(key);
	if (!parsedKey || !isPlainObject(payload)) return null;

	let source = null;
	if (Array.isArray(payload?.hits?.hits) && payload.hits.hits.length > 0) source = payload.hits.hits[0]?._source || null;
	else if (isPlainObject(payload?.response?.docs?.[0])) source = payload.response.docs[0];
	else source = payload;
	if (!isPlainObject(source)) return null;

	// Scraped-only reference records intentionally have no live FINRA/SEC coverage; never prune them.
	if (isOrphanPayload(source)) return null;

	const built = parsedKey.entity === 'individual' ? buildIndividualStub(source) : buildFirmStub(source);
	const coverage = parsedKey.entity === 'individual' ? hasIndividualCoverage(built.detail, parsedKey.source) : hasFirmCoverage(built.detail, parsedKey.source);

	let reason = null;
	if (built.searchHitOnly) reason = coverage ? 'search-hit-only-detail-key' : 'search-hit-only-wrong-scope';
	else if (!coverage) reason = 'explicit-not-in-scope';

	if (!reason) return null;
	return {
		...parsedKey,
		reason,
		searchHitOnly: built.searchHitOnly,
	};
}

async function scanKeys(redis, pattern, maxKeys) {
	let cursor = '0';
	const keys = [];
	do {
		const result = await redis.scan(cursor, { match: pattern, count: COUNT });
		const nextCursor = Array.isArray(result) ? result[0] : result?.cursor;
		const batch = Array.isArray(result) ? result[1] || [] : result?.keys || [];
		for (const key of batch) {
			keys.push(String(key));
			if (keys.length >= maxKeys) return keys;
		}
		cursor = String(nextCursor || '0');
	} while (cursor !== '0');
	return keys;
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('UPSTASH env vars required');
		process.exit(1);
	}

	const redis = new Redis({ url, token });
	let scanned = 0;
	let matched = 0;
	let deleted = 0;
	const byReason = {};

	for (const pattern of PATTERNS) {
		const keys = await scanKeys(redis, pattern, MAX_KEYS);
		for (const key of keys) {
			scanned += 1;
			let type = 'none';
			try {
				type = await redis.type(key);
			} catch {
				continue;
			}
			if (type !== 'string') continue;
			const raw = await redis.get(key).catch(() => null);
			const payload = parseRawValue(raw);
			const classified = classifyPayload(key, payload);
			if (!classified) continue;
			matched += 1;
			byReason[classified.reason] = (byReason[classified.reason] || 0) + 1;
			console.log(`${APPLY ? 'REMOVE' : 'MATCH'} ${classified.reason} ${key}`);
			if (APPLY) {
				await redis.del(key).catch(() => 0);
				deleted += 1;
			}
		}
	}

	console.log(
		JSON.stringify(
			{
				apply: APPLY,
				scanned,
				matched,
				deleted,
				byReason,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error?.message || error);
	process.exit(1);
});
