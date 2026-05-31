/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * dataMerge.ts – Merge FINRA and SEC data from local cached files.
 * Ported from server/services/dataMerge/mergeFinraSec.js
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './constants';
import { getFullGraph } from './graphStore';

// Resolve the 'national' data directory, falling back to any national.bak-* sibling if present
function resolveNationalBase() {
	const primary = path.join(DATA_DIR, 'national');
	try {
		const stat = require('fs').statSync(primary);
		if (stat && stat.isDirectory()) return primary;
	} catch (e) {
		// ignore
	}
	try {
		const entries = require('fs').readdirSync(DATA_DIR, { withFileTypes: true });
		for (const ent of entries) {
			if (!ent.isDirectory()) continue;
			if (ent.name.startsWith('national.bak') || ent.name.startsWith('national.')) {
				const candidate = path.join(DATA_DIR, ent.name);
				try {
					const stat2 = require('fs').statSync(candidate);
					if (stat2 && stat2.isDirectory()) return candidate;
				} catch {}
			}
		}
	} catch (e) {
		// ignore
	}
	return primary; // fallback even if missing
}

const BASE = resolveNationalBase();
const FINRA_DIR = path.join(BASE, 'brokercheck.finra.org');
const SEC_DIR = path.join(BASE, 'adviserinfo.sec.gov');

let _loaded = false;
let _loadingPromise: Promise<void> | null = null;
const finraIndividuals = new Map<string, any>();
const secIndividuals = new Map<string, any>();

function extractCanonicalIndividualSource(json: any, contentKey: 'content' | 'iacontent') {
	if (!json || typeof json !== 'object') return null;

	const hits = Array.isArray(json?.hits?.hits) ? json.hits.hits : [];
	if (hits.length) {
		const src = hits[0]?._source || {};
		let parsed = null;
		const rawContent = src?.[contentKey] ?? src?.content ?? src?.iacontent;
		if (rawContent) {
			try {
				parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
			} catch {
				parsed = null;
			}
		}
		const candidate = parsed && typeof parsed === 'object' ? { ...src, ...parsed } : src;
		return candidate && typeof candidate === 'object' ? candidate : null;
	}

	const direct = json?.[contentKey] ?? json?.content ?? json?.iacontent;
	if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
		return direct;
	}

	if (json?.basicInformation || json?.currentEmployments || json?.previousEmployments || json?.currentIAEmployments || json?.previousIAEmployments || json?.disclosures) {
		return json;
	}

	return null;
}

function getIndividualId(candidate: any) {
	if (!candidate || typeof candidate !== 'object') return null;
	return (
		candidate.ind_source_id ||
		candidate.person?.crd ||
		candidate.individualId ||
		candidate.crd ||
		candidate.basicInformation?.individualId ||
		candidate.basicInformation?.crd ||
		null
	);
}

async function _loadFinraFiles() {
	try {
		const files = await readdir(FINRA_DIR);
		if (!files || !files.length) return;
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			if (!f.startsWith('dl_') && !f.startsWith('query_') && !f.startsWith('individual_') && !f.startsWith('summary_') && !f.startsWith('api.brokercheck.finra.org_search_'))
				continue;
			try {
				const raw = await readFile(path.join(FINRA_DIR, f), 'utf-8');
				const json = JSON.parse(raw);
				const candidate = extractCanonicalIndividualSource(json, 'content');
				const id = getIndividualId(candidate);
				if (!id) continue;
				if (candidate?.currentEmployments) candidate.ind_current_employments = candidate.currentEmployments;
				if (candidate?.previousEmployments) candidate.ind_previous_employments = candidate.previousEmployments;
				if (candidate?.currentIAEmployments) candidate.ind_ia_current_employments = candidate.currentIAEmployments;
				if (candidate?.previousIAEmployments) candidate.ind_ia_previous_employments = candidate.previousIAEmployments;
				if (!candidate.ind_source_id) candidate.ind_source_id = String(id);
				finraIndividuals.set(String(candidate.ind_source_id || id), candidate);
			} catch {}
		}
	} catch {}
}

async function _loadSecFiles() {
	try {
		const files = await readdir(SEC_DIR);
		if (!files || !files.length) return;
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			try {
				const raw = await readFile(path.join(SEC_DIR, f), 'utf-8');
				const json = JSON.parse(raw);
				const candidate = extractCanonicalIndividualSource(json, 'iacontent');
				const id = getIndividualId(candidate);
				if (!id) continue;
				if (candidate?.currentEmployments) candidate.ind_current_employments = candidate.currentEmployments;
				if (candidate?.previousEmployments) candidate.ind_previous_employments = candidate.previousEmployments;
				if (candidate?.currentIAEmployments) candidate.ind_ia_current_employments = candidate.currentIAEmployments;
				if (candidate?.previousIAEmployments) candidate.ind_ia_previous_employments = candidate.previousIAEmployments;
				if (!candidate.ind_source_id) candidate.ind_source_id = String(id);
				secIndividuals.set(String(candidate.ind_source_id || id), candidate);
			} catch {}
		}
	} catch {}
}

async function ensureLoaded() {
	if (_loaded) return;
	if (!_loadingPromise) {
		_loadingPromise = (async () => {
			await Promise.all([_loadFinraFiles(), _loadSecFiles()]);
			_loaded = true;
		})().catch((error) => {
			_loaded = false;
			_loadingPromise = null;
			throw error;
		});
	}
	await _loadingPromise;
}

function _pickIndividualFields(src: any) {
	if (!src) return null;
	let parsed: any = null;
	if (src.content) {
		try {
			parsed = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
		} catch {}
	}
	return {
		ind_source_id: src.ind_source_id,
		firstName: src.ind_firstname || src.firstName || null,
		middleName: src.ind_middlename || src.middleName || null,
		lastName: src.ind_lastname || src.lastName || null,
		otherNames: src.ind_other_names || src.otherNames || [],
		bcScope: src.ind_bc_scope || src.bcScope || null,
		iaScope: src.ind_ia_scope || src.iaScope || null,
		disclosureFlag: src.ind_bc_disclosure_fl || src.disclosureFlag || null,
		industryCalDate: src.ind_industry_cal_date || src.industryCalDate || src.ind_industry_cal_date_iapd || null,
		currentEmployments: src.ind_current_employments || src.ind_ia_current_employments || (parsed ? parsed.currentEmployments || [] : []),
		previousEmployments: src.ind_previous_employments || src.ind_ia_previous_employments || (parsed ? parsed.previousEmployments || [] : []),
	};
}

function _eq(a: unknown, b: unknown) {
	return JSON.stringify(a) === JSON.stringify(b);
}

function computeDiffs(finra: any, sec: any) {
	const f = _pickIndividualFields(finra);
	const s = _pickIndividualFields(sec);
	const diffs: Record<string, any> = {};
	const keys = new Set([...(f ? Object.keys(f) : []), ...(s ? Object.keys(s) : [])]);
	for (const k of keys) {
		const fv = f ? (f as any)[k] : undefined;
		const sv = s ? (s as any)[k] : undefined;
		diffs[k] = { finra: fv ?? null, sec: sv ?? null, equal: _eq(fv, sv) };
	}
	return { finra: f, sec: s, diffs };
}

export async function mergedIndividual(crd: string) {
	await ensureLoaded();
	const id = String(crd);
	const finra = finraIndividuals.get(id) || null;
	const sec = secIndividuals.get(id) || null;
	const finra2 = finra || null;
	const sec2 = sec || null;
	const computed = computeDiffs(finra2, sec2);
	return {
		crd: id,
		found: !!(finra2 || sec2),
		sources: { finra: finra2 || null, sec: sec2 || null },
		merged: computed,
	};
}

// Development helper: clear in-memory loaded state so callers can force a reload
export function clearDataMergeCache() {
	_loaded = false;
	_loadingPromise = null;
	finraIndividuals.clear();
	secIndividuals.clear();
}

export async function mergedFirm(firmId: string) {
	await ensureLoaded();
	const id = String(firmId);
	const finraGraph = await getFullGraph();
	let firmNode: any = null;
	if (finraGraph && Array.isArray(finraGraph.nodes)) {
		firmNode = finraGraph.nodes.find((n: any) => n.group === 'firm' && String(n.firmId) === id);
	}

	const evidence: any[] = [];
	for (const [personKey, v] of finraIndividuals.entries()) {
		const emps = [...(v.ind_current_employments || []), ...(v.ind_previous_employments || []), ...(v.ind_ia_current_employments || []), ...(v.ind_ia_previous_employments || [])];
		for (const e of emps) {
			const fid = e?.firm_id || e?.firmId || null;
			if (!fid) continue;
			if (String(fid) === id) evidence.push({ personId: personKey, employment: e });
		}
	}

	return {
		firmId: id,
		found: !!(firmNode || evidence.length),
		finraNode: firmNode || null,
		evidence,
	};
}
