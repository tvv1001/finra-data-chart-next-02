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
const finraIndividuals = new Map<string, any>();
const secIndividuals = new Map<string, any>();

async function _loadFinraFiles() {
	try {
		const files = await readdir(FINRA_DIR);
		if (!files || !files.length) {
			// fallback: try any JSON files in primed-cache/ (load all entries)
			try {
				const pcDir = path.join(path.dirname(BASE), 'primed-cache');
				const pcFiles = await readdir(pcDir);
				for (const pf of pcFiles || []) {
					if (!pf.endsWith('.json')) continue;
					try {
						const rawpc = await readFile(path.join(pcDir, pf), 'utf-8');
						const pcJson = JSON.parse(rawpc || '{}');
						for (const [k, v] of Object.entries(pcJson)) {
							// try to derive an id
							let id = null;
							if (v && typeof v === 'object' && v.basicInformation && (v.basicInformation.individualId || v.basicInformation.crd)) {
								id = String(v.basicInformation.individualId || v.basicInformation.crd);
							} else {
								const m = String(k).match(/(\d{4,})/);
								if (m) id = m[1];
							}
							if (!id) continue;
							// store a src object with content field so downstream normalize logic can parse it
							finraIndividuals.set(String(id), { content: JSON.stringify(v), ind_source_id: id });
						}
					} catch (e) {
						// ignore malformed primed-cache file and continue
					}
				}
				return;
			} catch (e) {
				// ignore and continue to file scanning below
			}
		}
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			if (!f.startsWith('dl_') && !f.startsWith('query_') && !f.startsWith('individual_') && !f.startsWith('summary_') && !f.startsWith('api.brokercheck.finra.org_search_'))
				continue;
			try {
				const raw = await readFile(path.join(FINRA_DIR, f), 'utf-8');
				const json = JSON.parse(raw);
				const hits = json?.hits?.hits || [];
				for (const h of hits) {
					const src = h._source || {};
					// prefer person/individual identifiers only; do NOT use firm_id here
					let id = src.ind_source_id || src.person?.crd || null;
					if (src.content) {
						try {
							const parsed = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
							if (parsed?.currentEmployments) src.ind_current_employments = parsed.currentEmployments;
							if (parsed?.previousEmployments) src.ind_previous_employments = parsed.previousEmployments;
							if (!id) id = parsed?.basicInformation?.individualId || parsed?.basicInformation?.crd || id;
							// determine if this source looks like an individual record
							const looksLikeIndividual = !!(src.ind_source_id || src.person?.crd || parsed?.basicInformation || parsed?.currentEmployments || parsed?.previousEmployments);
							if (!looksLikeIndividual) continue; // skip firm-like records
						} catch {}
					}
					if (!id) continue;
					if (src.ind_source_id) finraIndividuals.set(String(src.ind_source_id), src);
					else finraIndividuals.set(String(id), src);
				}
			} catch {}
		}
	} catch {}
}

async function _loadSecFiles() {
	try {
		const files = await readdir(SEC_DIR);
		if (!files || !files.length) {
			// fallback: try primed-cache/sec-individual.json or sec-firm.json
			try {
				const pcPath = path.join(path.dirname(BASE), 'primed-cache', 'sec-individual.json');
				const rawpc = await readFile(pcPath, 'utf-8');
				const pcJson = JSON.parse(rawpc || '{}');
				for (const [k, v] of Object.entries(pcJson)) {
					let id = null;
					if (v && typeof v === 'object' && v.basicInformation && (v.basicInformation.individualId || v.basicInformation.crd)) {
						id = String(v.basicInformation.individualId || v.basicInformation.crd);
						// treat as individual
						secIndividuals.set(String(id), { content: JSON.stringify(v), ind_source_id: id });
					} else {
						// skip non-individual entries (firm records) when populating individual map
						continue;
					}
				}
				return;
			} catch (e) {
				// ignore
			}
		}
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			try {
				const raw = await readFile(path.join(SEC_DIR, f), 'utf-8');
				const json = JSON.parse(raw);
				const hits = json?.hits?.hits || [];
				for (const h of hits) {
					const src = h._source || {};
					// prefer person/individual identifiers only; do NOT use firm_id here
					let id = src.ind_source_id || src.person?.crd || null;
					if (src.content) {
						try {
							const parsed = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
							if (parsed?.currentEmployments) src.ind_current_employments = parsed.currentEmployments;
							if (parsed?.previousEmployments) src.ind_previous_employments = parsed.previousEmployments;
							if (!id) id = parsed?.basicInformation?.individualId || parsed?.basicInformation?.crd || id;
							// determine if this source looks like an individual record
							const looksLikeIndividual = !!(src.ind_source_id || src.person?.crd || parsed?.basicInformation || parsed?.currentEmployments || parsed?.previousEmployments);
							if (!looksLikeIndividual) continue; // skip firm-like records
						} catch {}
					}
					if (!id) continue;
					if (src.ind_source_id) secIndividuals.set(String(src.ind_source_id), src);
					else if (id) secIndividuals.set(String(id), src);
				}
			} catch {}
		}
	} catch {}
}

async function ensureLoaded() {
	if (_loaded) return;
	_loaded = true;
	await Promise.all([_loadFinraFiles(), _loadSecFiles()]);
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
	// If neither FINRA nor SEC were found in the loaded maps, try scanning primed-cache
	// for any JSON files that may contain per-id additions (fallback for compacted primed-cache)
	if (!finra && !sec) {
		try {
			const pcDir = path.join(path.dirname(BASE), 'primed-cache');
			const files = await readdir(pcDir);
			for (const f of files || []) {
				if (!f.endsWith('.json')) continue;
				try {
					const raw = await readFile(path.join(pcDir, f), 'utf-8');
					const parsed = JSON.parse(raw || '{}');
					for (const [k, v] of Object.entries(parsed)) {
						try {
							const cand = typeof v === 'string' ? JSON.parse(v) : v;
							const bi = cand?.basicInformation || {};
							const id2 = String(bi.individualId || bi.crd || '').trim();
							if (!id2) continue;
							// ensure this candidate is an individual record (not a firm)
							const looksLikeIndividual = !!(cand?.basicInformation || cand?.currentEmployments || cand?.previousEmployments || cand?.person?.crd);
							if (id2 === id && looksLikeIndividual) {
								finraIndividuals.set(id, { content: JSON.stringify(cand), ind_source_id: id });
								break;
							}
						} catch {}
					}
				} catch {}
				if (finraIndividuals.has(id) || secIndividuals.has(id)) break;
			}
		} catch (e) {
			// ignore
		}
	}
	const finra2 = finraIndividuals.get(id) || null;
	const sec2 = secIndividuals.get(id) || null;
	const computed = computeDiffs(finra2, sec2);
	return {
		crd: id,
		found: !!(finra2 || sec2),
		sources: { finra: finra2 || null, sec: sec2 || null },
		merged: computed,
	};
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
