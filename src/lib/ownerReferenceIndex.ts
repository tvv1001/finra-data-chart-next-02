import { getRedisClient } from '@/lib/redisCache';
import { canWriteToRedis, isRedisCacheOnly } from '@/lib/redisAvailability';

// Individuals who are scraped-only references (e.g. FINRA/SEC firm-page "Direct Owners &
// Executive Officers" entries) frequently have no independent, searchable BrokerCheck/IAPD
// record of their own. This module maintains a lightweight reverse index — keyed by the
// individual's CRD — so `/api/finra/individual/[crd]` can recognize these "orphan" CRDs and
// surface the scraped name/position/firm metadata instead of a bare "not found" response.

const OWNER_REF_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type OwnerReference = {
	crd: string;
	name?: string;
	position?: string;
	firmName?: string;
	parentCrd: string;
	parentType: 'firm' | 'individual';
	officeAddress?: Record<string, unknown>;
	mailingAddress?: Record<string, unknown>;
	phone?: string;
};

// Local-only namespace for stubbed/non-live CRDs; do not push these records to the
// cloud Upstash mirrors for routine local work.
function nonLiveCrdKey(kind: 'individual' | 'firm', crd: string): string {
	return `non-live-crds:${kind}:${String(crd).trim()}`;
}

function legacyNonLiveCrdKey(kind: 'individual' | 'firm', crd: string): string {
	return `owner-ref:${kind}:${String(crd).trim()}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseRedisReference(raw: unknown): OwnerReference | null {
	if (raw == null) return null;
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw) as OwnerReference;
		} catch {
			return null;
		}
	}
	if (isPlainObject(raw)) return raw as OwnerReference;
	return null;
}

/** Best-effort, non-blocking write. Never throws — callers should fire-and-forget this. */
export async function recordOwnerReference(reference: OwnerReference): Promise<void> {
	const crd = String(reference.crd || '').trim();
	if (!/^\d{1,10}$/.test(crd)) return;
	if (!canWriteToRedis()) return;
	const redis = getRedisClient();
	if (!redis) return;

	try {
		await redis.set(nonLiveCrdKey('individual', crd), JSON.stringify(reference), { ex: OWNER_REF_TTL_SECONDS });
	} catch {
		// swallow: this is a best-effort index, never allow it to break the firm fetch response
	}
}

/**
 * Records owner-reference entries for every direct/indirect owner of a firm that carries a
 * numeric CRD. Intended to be called (fire-and-forget) whenever a firm detail payload is
 * built, so subsequent individual lookups for these CRDs can resolve as orphan records.
 */
export async function recordOwnerReferencesForFirm(params: {
	parentCrd: string;
	firmName?: string;
	officeAddress?: Record<string, unknown>;
	mailingAddress?: Record<string, unknown>;
	phone?: string;
	owners: Array<Record<string, unknown>>;
}): Promise<void> {
	const parentCrd = String(params.parentCrd || '').trim();
	if (!parentCrd || !Array.isArray(params.owners) || !params.owners.length) return;

	const writes: Promise<void>[] = [];
	for (const owner of params.owners) {
		if (!isPlainObject(owner)) continue;
		const crd = String(owner.crdNumber ?? owner.crd ?? owner.individualId ?? '').trim();
		if (!/^\d{1,10}$/.test(crd)) continue;

		writes.push(
			recordOwnerReference({
				crd,
				name: typeof owner.legalName === 'string' ? owner.legalName : typeof owner.name === 'string' ? owner.name : undefined,
				position: typeof owner.position === 'string' ? owner.position : typeof owner.title === 'string' ? owner.title : undefined,
				firmName: params.firmName,
				parentCrd,
				parentType: 'firm',
				officeAddress: params.officeAddress,
				mailingAddress: params.mailingAddress,
				phone: params.phone,
			}),
		);
	}

	await Promise.allSettled(writes);
}

export async function lookupOwnerReference(crd: string): Promise<OwnerReference | null> {
	const normalizedCrd = String(crd || '').trim();
	if (!/^\d{1,10}$/.test(normalizedCrd)) return null;
	if (isRedisCacheOnly()) return null;
	const redis = getRedisClient();
	if (!redis) return null;

	try {
		for (const key of [nonLiveCrdKey('individual', normalizedCrd), legacyNonLiveCrdKey('individual', normalizedCrd)]) {
			const raw = await redis.get(key);
			const parsed = parseRedisReference(raw);
			if (parsed) return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

// Reciprocal case: firms that are scraped-only references (e.g. a firm CRD/name that appears
// only in an individual's current/previous employment history — such as one scraped directly
// from that person's BrokerCheck summary page — with no independent, searchable
// BrokerCheck/IAPD firm record of their own). This mirrors the individual owner-reference index
// above but keyed by the firm's CRD, so `/api/finra/firm/[id]` can recognize these "orphan" firm
// CRDs and surface the scraped firm name/address metadata instead of a bare "not found" response.

function firmRefKey(crd: string): string {
	return nonLiveCrdKey('firm', crd);
}

/** Best-effort, non-blocking write. Never throws — callers should fire-and-forget this. */
export async function recordFirmReference(reference: OwnerReference): Promise<void> {
	const crd = String(reference.crd || '').trim();
	if (!/^\d{1,10}$/.test(crd)) return;
	if (!canWriteToRedis()) return;
	const redis = getRedisClient();
	if (!redis) return;

	try {
		await redis.set(firmRefKey(crd), JSON.stringify(reference), { ex: OWNER_REF_TTL_SECONDS });
	} catch {
		// swallow: this is a best-effort index, never allow it to break the individual fetch response
	}
}

/**
 * Records firm-reference entries for every employer with a numeric firmId found in an
 * individual's employment history. Intended to be called (fire-and-forget) whenever an
 * individual detail payload is built, so subsequent firm lookups for these CRDs can resolve
 * as orphan records.
 */
export async function recordFirmReferencesForIndividual(params: { parentCrd: string; individualName?: string; employments: Array<Record<string, unknown>> }): Promise<void> {
	const parentCrd = String(params.parentCrd || '').trim();
	if (!parentCrd || !Array.isArray(params.employments) || !params.employments.length) return;

	const seen = new Set<string>();
	const writes: Promise<void>[] = [];
	for (const employment of params.employments) {
		if (!isPlainObject(employment)) continue;
		const crd = String((employment as Record<string, unknown>).firmId ?? (employment as Record<string, unknown>).firm_id ?? '').trim();
		if (!/^\d{1,10}$/.test(crd) || seen.has(crd)) continue;
		seen.add(crd);

		const branches = (employment as Record<string, unknown>).branchOfficeLocations;
		const branch = Array.isArray(branches) && isPlainObject(branches[0]) ? (branches[0] as Record<string, unknown>) : null;
		const officeAddress =
			branch ?
				{
					street1: branch.street1,
					street2: branch.street2,
					city: branch.city,
					state: branch.state,
					postalCode: branch.zipCode,
					country: branch.country,
				}
			:	undefined;

		writes.push(
			recordFirmReference({
				crd,
				firmName: typeof (employment as Record<string, unknown>).firmName === 'string' ? ((employment as Record<string, unknown>).firmName as string) : undefined,
				name: params.individualName,
				parentCrd,
				parentType: 'individual',
				officeAddress,
			}),
		);
	}

	await Promise.allSettled(writes);
}

export async function lookupFirmReference(crd: string): Promise<OwnerReference | null> {
	const normalizedCrd = String(crd || '').trim();
	if (!/^\d{1,10}$/.test(normalizedCrd)) return null;
	if (isRedisCacheOnly()) return null;
	const redis = getRedisClient();
	if (!redis) return null;

	try {
		for (const key of [firmRefKey(normalizedCrd), legacyNonLiveCrdKey('firm', normalizedCrd)]) {
			const raw = await redis.get(key);
			const parsed = parseRedisReference(raw);
			if (parsed) return parsed;
		}
		return null;
	} catch {
		return null;
	}
}
