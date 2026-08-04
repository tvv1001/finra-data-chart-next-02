import { getRedisClient } from '@/lib/redisCache';

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

function ownerRefKey(crd: string): string {
	return `owner-ref:individual:${String(crd).trim()}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Best-effort, non-blocking write. Never throws — callers should fire-and-forget this. */
export async function recordOwnerReference(reference: OwnerReference): Promise<void> {
	const crd = String(reference.crd || '').trim();
	if (!/^\d{1,10}$/.test(crd)) return;
	const redis = getRedisClient();
	if (!redis) return;

	try {
		await redis.set(ownerRefKey(crd), JSON.stringify(reference), { ex: OWNER_REF_TTL_SECONDS });
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
	const redis = getRedisClient();
	if (!redis) return null;

	try {
		const raw = await redis.get(ownerRefKey(normalizedCrd));
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
	} catch {
		return null;
	}
}
