import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/cache';
import { DEFAULT_HEADERS } from '@/lib/constants';
import { DATA_DIR } from '@/lib/constants';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { rememberRecentSeed } from '@/lib/graphStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

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
			merged[key] = key in merged ? mergePreferPrimary(merged[key], value) : value;
		}
		return merged;
	}
	return primary;
}

function buildIndividualQueryParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();
	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'includesPrevious' && !searchParams.has('includePrevious')) {
			params.set('includePrevious', value);
			continue;
		}
		params.set(key, value);
	}
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	if (!params.has('includePrevious')) params.set('includePrevious', 'true');
	params.delete('nrows');
	return params;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ crd: string }> }) {
	const { crd } = await params;
	if (!/^\d{1,10}$/.test(crd)) {
		return NextResponse.json({ error: 'Invalid CRD number.' }, { status: 400 });
	}
	void rememberRecentSeed('individual', crd).catch((error) => {
		logger.warn('failed to remember recent individual seed', { crd, error: error?.message || String(error) });
	});

	try {
		// Try local primed-cache before hitting external APIs when available (offline-friendly)
		let finraPrimed = null;
		let secPrimed = null;
		try {
			const pcFinra = path.join(DATA_DIR, 'primed-cache', 'finra-individual.json');
			const pcSec = path.join(DATA_DIR, 'primed-cache', 'sec-individual.json');
			const [rawFinra, rawSec] = await Promise.allSettled([readFile(pcFinra, 'utf-8'), readFile(pcSec, 'utf-8')]);
			if (rawFinra.status === 'fulfilled') {
				const json = JSON.parse(rawFinra.value || '{}');
				// try to find an entry matching the crd
				for (const [k, v] of Object.entries(json)) {
					try {
						const candidate = typeof v === 'string' ? JSON.parse(v) : v;
						const bi = candidate?.basicInformation || {};
						const id = String(bi.individualId || bi.crd || bi.individualId || '').trim();
						if (id === crd) {
							finraPrimed = { content: candidate };
							break;
						}
					} catch {}
				}
			}
			// if not found in finra-individual.json, scan other primed-cache JSON files (e.g. additions)
			if (!finraPrimed) {
				try {
					const pcDir = path.join(DATA_DIR, 'primed-cache');
					const files = await readdir(pcDir);
					for (const f of files || []) {
						if (!f.endsWith('.json')) continue;
						if (f === path.basename(path.join(DATA_DIR, 'primed-cache', 'finra-individual.json'))) continue;
						try {
							const raw = await readFile(path.join(pcDir, f), 'utf-8');
							const parsed = JSON.parse(raw || '{}');
							for (const [k2, v2] of Object.entries(parsed)) {
								try {
									const cand = typeof v2 === 'string' ? JSON.parse(v2) : v2;
									const bi2 = cand?.basicInformation || {};
									const id2 = String(bi2.individualId || bi2.crd || '').trim();
									if (id2 === crd) {
										finraPrimed = { content: cand };
										break;
									}
								} catch {}
							}
						} catch {}
						if (finraPrimed) break;
					}
				} catch {}
			}
			if (rawSec.status === 'fulfilled') {
				const json = JSON.parse(rawSec.value || '{}');
				for (const [k, v] of Object.entries(json)) {
					try {
						const candidate = typeof v === 'string' ? JSON.parse(v) : v;
						const bi = candidate?.basicInformation || {};
						const id = String(bi.individualId || bi.crd || bi.individualId || '').trim();
						if (id === crd) {
							secPrimed = { iacontent: candidate };
							break;
						}
					} catch {}
				}
			}
			// if not found in sec-individual.json, scan other primed-cache JSON files
			if (!secPrimed) {
				try {
					const pcDir = path.join(DATA_DIR, 'primed-cache');
					const files = await readdir(pcDir);
					for (const f of files || []) {
						if (!f.endsWith('.json')) continue;
						if (f === path.basename(path.join(DATA_DIR, 'primed-cache', 'sec-individual.json'))) continue;
						try {
							const raw = await readFile(path.join(pcDir, f), 'utf-8');
							const parsed = JSON.parse(raw || '{}');
							for (const [k2, v2] of Object.entries(parsed)) {
								try {
									const cand = typeof v2 === 'string' ? JSON.parse(v2) : v2;
									const bi2 = cand?.basicInformation || {};
									const id2 = String(bi2.individualId || bi2.crd || '').trim();
									if (id2 === crd) {
										secPrimed = { iacontent: cand };
										break;
									}
								} catch {}
							}
						} catch {}
						if (secPrimed) break;
					}
				} catch {}
			}
		} catch (e) {
			// ignore primed-cache read errors
		}
		const { default: axios } = await import('axios');
		const params = buildIndividualQueryParams(new URL(request.url).searchParams);
		const queryString = params.toString();

		const requests = await Promise.allSettled([
			cachedFetch(`finra:individual:${crd}:${queryString}`, 60 * 60 * 24, async () => {
				const finraUrl =
					queryString ?
						`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${queryString}`
					:	`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}`;
				const r = await axios.get(finraUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
				return r.data;
			}),
			cachedFetch(`sec:individual:${crd}:${queryString}`, 60 * 60 * 24, async () => {
				const secUrl =
					queryString ?
						`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?${queryString}`
					:	`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?wt=json`;
				const r = await axios.get(secUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
				return r.data;
			}),
		]);

		const finraData = requests[0].status === 'fulfilled' ? requests[0].value : null;
		const secData = requests[1].status === 'fulfilled' ? requests[1].value : null;

		if (requests[0].status === 'rejected') {
			logger.warn('individual FINRA fetch failed', {
				crd,
				error: requests[0].reason?.message || String(requests[0].reason || 'unknown error'),
			});
		}
		if (requests[1].status === 'rejected') {
			logger.warn('individual SEC fetch failed', {
				crd,
				error: requests[1].reason?.message || String(requests[1].reason || 'unknown error'),
			});
		}

		const finraDetail = parseDetailPayload(finraData, 'content');
		const secDetail = parseDetailPayload(secData, 'iacontent');
		if (!finraDetail && !secDetail) {
			return NextResponse.json({ found: false }, { status: 200, headers: sharedCacheHeaders(3600) });
		}

		const detail: any =
			finraDetail ?
				secDetail ? mergePreferPrimary(secDetail, finraDetail)
				:	finraDetail
			:	secDetail;

		// determine whether parsed details contain a usable numeric identifier
		function findNumericId(obj: any, candidates: string[]) {
			if (!obj || typeof obj !== 'object') return '';
			for (const key of candidates) {
				const v = obj[key];
				if (v == null) continue;
				const s = String(v).trim();
				if (/^\d+$/.test(s)) return s;
				if (/^8-\d+$/i.test(s)) return s;
			}
			// try nested basicInformation
			const bi = obj.basicInformation || obj.basic_information || obj.basic || null;
			if (bi && typeof bi === 'object') {
				for (const key of candidates) {
					const v = bi[key];
					if (v == null) continue;
					const s = String(v).trim();
					if (/^\d+$/.test(s)) return s;
					if (/^8-\d+$/i.test(s)) return s;
				}
			}
			return '';
		}

		const finraNumeric = finraDetail ? findNumericId(finraDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';
		const secNumeric = secDetail ? findNumericId(secDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';

		detail.hasFinraData = !!finraDetail && !!finraNumeric;
		detail.hasSecData = !!secDetail && !!secNumeric;

		return NextResponse.json(detail, { headers: sharedCacheHeaders(3600) });
	} catch (err: any) {
		logger.error('individual proxy error', { crd, error: err.message });
		return NextResponse.json({ error: 'Failed to fetch from FINRA.' }, { status: 502 });
	}
}
