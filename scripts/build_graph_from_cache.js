#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { Redis } = require('@upstash/redis');
const axios = require('axios');

const ROOT = process.cwd();
const BASE = path.join(ROOT, 'data', 'national');
const FINRA = path.join(BASE, 'brokercheck.finra.org');
const SEC = path.join(BASE, 'adviserinfo.sec.gov');
const GRAPH_FILE = path.join(BASE, 'finra-graph.json');
const SEED_BANK_FILE = path.join(BASE, 'finra-seed-bank.json');
const REDIS_GRAPH_KEY = 'finra:graph';
const REDIS_SEED_BANK_KEY = 'finra:seed-bank';

function personId(crd) {
	return `person:${crd}`;
}
function firmId(id) {
	return `firm:${id}`;
}

let redisClient;
function getRedis() {
	if (redisClient !== undefined) return redisClient;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	redisClient = url && token ? new Redis({ url, token }) : null;
	return redisClient;
}

function resolveId(ref) {
	if (ref && typeof ref === 'object') return ref.id ?? null;
	return ref ?? null;
}

function uniqueSortedIds(values) {
	return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function firstMeaningfulText(...values) {
	for (const value of values) {
		const text = String(value || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (text) return text;
	}
	return '';
}

function normalizeSeedName(value) {
	const text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return '';
	if (
		/^\d+$/.test(text) ||
		/^\d+-\d+$/.test(text) ||
		/^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(text) ||
		/^8-\d+$/i.test(text) ||
		/^person\s+\d+$/i.test(text) ||
		/^firm\s+\d+$/i.test(text)
	) {
		return '';
	}
	return text;
}

function getSeedNodeDisplayName(node) {
	const basic = node?.basicInformation || {};
	if (node?.group === 'individual') {
		const fullName = [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ');
		return normalizeSeedName(firstMeaningfulText(fullName, basic.name, node?.name, node?.personName, node?.displayName, node?.legalName, node?.label));
	}
	if (node?.group === 'firm') {
		return normalizeSeedName(
			firstMeaningfulText(
				basic.firmName,
				basic.name,
				node?.firmName,
				node?.organizationName,
				node?.organization_name,
				node?.companyName,
				node?.name,
				node?.displayName,
				node?.legalName,
				node?.label,
			),
		);
	}
	return '';
}

function getNumericSeedNumber(nodeId, group) {
	const prefix = group === 'individual' ? 'person:' : 'firm:';
	if (!String(nodeId || '').startsWith(prefix)) return '';
	const rawNumber = String(nodeId || '')
		.slice(prefix.length)
		.trim();
	return /^\d+$/.test(rawNumber) ? rawNumber : '';
}

function buildSeedBankFromGraph(graph) {
	const individuals = [];
	const firms = [];
	const entities = [];
	const others = [];
	const allNodeIds = [];
	const nameByNumber = { individual: {}, firm: {} };

	for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
		const nodeId = resolveId(node);
		if (!nodeId) continue;
		allNodeIds.push(nodeId);
		switch (node?.group) {
			case 'individual':
				individuals.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'individual');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.individual[rawNumber] = displayName;
				}
				break;
			case 'firm':
				firms.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'firm');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.firm[rawNumber] = displayName;
				}
				break;
			case 'entity':
				entities.push(nodeId);
				break;
			default:
				others.push(nodeId);
				break;
		}
	}

	const individualIds = uniqueSortedIds(individuals);
	const firmIds = uniqueSortedIds(firms);
	const entityIds = uniqueSortedIds(entities);
	const otherIds = uniqueSortedIds(others);
	const uniqueAllNodeIds = uniqueSortedIds(allNodeIds);

	return {
		individualIds,
		firmIds,
		entityIds,
		otherIds,
		allNodeIds: uniqueAllNodeIds,
		nameByNumber,
		updatedAt: new Date().toISOString(),
		counts: {
			individuals: individualIds.length,
			firms: firmIds.length,
			entities: entityIds.length,
			others: otherIds.length,
			totalNodes: uniqueAllNodeIds.length,
		},
	};
}

async function saveGraphArtifacts(graph, { syncRedis = true } = {}) {
	const seedBank = buildSeedBankFromGraph(graph);
	await fs.mkdir(path.dirname(GRAPH_FILE), { recursive: true });
	await fs.writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2), 'utf-8');
	await fs.writeFile(SEED_BANK_FILE, JSON.stringify(seedBank, null, 2), 'utf-8');

	if (!syncRedis) return { graphFile: GRAPH_FILE, seedBankFile: SEED_BANK_FILE, redisSynced: false };

	const redis = getRedis();
	if (!redis) return { graphFile: GRAPH_FILE, seedBankFile: SEED_BANK_FILE, redisSynced: false };

	await redis.set(REDIS_GRAPH_KEY, JSON.stringify(graph));
	await redis.set(REDIS_SEED_BANK_KEY, JSON.stringify(seedBank));
	return { graphFile: GRAPH_FILE, seedBankFile: SEED_BANK_FILE, redisSynced: true };
}

async function ensureGraphArtifacts(options = {}) {
	try {
		await fs.access(GRAPH_FILE);
		return { existed: true, built: false };
	} catch {
		console.log('finra-graph.json missing; rebuilding from cached source files.');
		await build(options);
		return { existed: false, built: true };
	}
}

function normalizeEmploymentScope(rawValue) {
	const value = String(rawValue || 'current')
		.trim()
		.toLowerCase();
	if (['current', 'previous', 'all', 'none'].includes(value)) return value;
	throw new Error(`Invalid employment scope "${rawValue}". Use current, previous, all, or none.`);
}

function getEmploymentScopeOptions(scope) {
	return {
		scope,
		includeCurrent: scope === 'current' || scope === 'all',
		includePrevious: scope === 'previous' || scope === 'all',
		enableHeuristicEmploymentLinks: scope === 'all',
	};
}

function collectEmploymentRecords(source, options) {
	if (!source || typeof source !== 'object' || options.scope === 'none') return [];
	const records = [];
	if (options.includeCurrent) {
		records.push(...(source.ind_current_employments || source.currentEmployments || []));
	}
	if (options.includePrevious) {
		records.push(...(source.ind_previous_employments || source.previousEmployments || []));
	}
	return records;
}

async function readJsonFiles(dir) {
	const out = [];
	try {
		const files = await fs.readdir(dir);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			try {
				const raw = await fs.readFile(path.join(dir, f), 'utf-8');
				out.push({ file: f, json: JSON.parse(raw) });
			} catch {}
		}
	} catch {}
	return out;
}

function extractPeopleAndFirmsFromHits(json, employmentOptions) {
	const nodes = { people: new Map(), firms: new Map(), links: [] };
	const hits = json?.hits?.hits || [];
	for (const h of hits) {
		const src = h._source || {};
		const crd =
			src.ind_source_id ||
			src.person?.crd ||
			(src.content &&
				(() => {
					try {
						const p = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
						return p?.basicInformation?.crd || p?.basicInformation?.individualId;
					} catch {
						return null;
					}
				})());
		if (crd) {
			nodes.people.set(String(crd), { id: personId(crd), label: `${src.ind_firstname || ''} ${src.ind_lastname || ''}`.trim() || String(crd), group: 'individual' });
			const emps = collectEmploymentRecords(src, employmentOptions);
			for (const e of emps) {
				const fid = e.firmId || e.firm_id || e.firmId;
				if (fid) {
					nodes.firms.set(String(fid), { id: firmId(fid), label: e.firmName || String(fid), group: 'firm' });
					nodes.links.push({ source: personId(crd), target: firmId(fid), relationship: 'employed_by' });
				}
			}
		}
		// firms in source
		if (src.firm_id || src.firm_bd_sec_number || src.firm_bd_full_sec_number) {
			const fid = src.firm_id || src.firm_bd_sec_number || src.firm_bd_full_sec_number;
			nodes.firms.set(String(fid), { id: firmId(fid), label: src.firm_name || src.firmName || String(fid), group: 'firm' });
		}
	}
	return nodes;
}

function normalizeLink(link) {
	if (!link || typeof link !== 'object') return link;
	const sourceId = String(link.source?.id ?? link.source ?? '');
	const targetId = String(link.target?.id ?? link.target ?? '');
	const inferredRelationship =
		sourceId.startsWith('person:') && targetId.startsWith('firm:') ? 'employed_by'
		: (sourceId.startsWith('firm:') || sourceId.startsWith('entity:')) && targetId.startsWith('firm:') ? 'controls'
		: '';
	const relationship = link.relationship || link.type || inferredRelationship || '';
	const normalized = relationship ? { ...link, relationship } : { ...link };
	if ('type' in normalized) delete normalized.type;
	if (normalized.relationship === 'previous_employed_by' && normalized.isCurrent === undefined) {
		normalized.isCurrent = false;
	}
	return normalized;
}

async function build(options = {}) {
	const employmentOptions = options.employmentOptions || getEmploymentScopeOptions('current');
	const syncRedis = options.syncRedis !== false;
	let existingGraph = { nodes: [], links: [], meta: {} };
	try {
		existingGraph = JSON.parse(await fs.readFile(GRAPH_FILE, 'utf-8'));
	} catch {
		existingGraph = { nodes: [], links: [], meta: {} };
	}
	existingGraph = {
		...(existingGraph || {}),
		nodes: Array.isArray(existingGraph?.nodes) ? existingGraph.nodes : [],
		links: Array.isArray(existingGraph?.links) ? existingGraph.links.map((link) => normalizeLink(link)) : [],
		meta: existingGraph?.meta && typeof existingGraph.meta === 'object' ? existingGraph.meta : {},
	};
	const finraFiles = await readJsonFiles(FINRA);
	const secFiles = await readJsonFiles(SEC);
	const people = new Map();
	const firms = new Map();
	const links = [];
	const parsedFiles = [...finraFiles, ...secFiles];

	console.log(`build_graph_from_cache: employment scope=${employmentOptions.scope}`);

	if (parsedFiles.length === 0) {
		try {
			const existing = existingGraph;
			if ((Array.isArray(existing?.nodes) && existing.nodes.length) || (Array.isArray(existing?.links) && existing.links.length)) {
				console.log('No cached host JSON files found; preserving existing graph artifact.');
				const saved = await saveGraphArtifacts(existing, { syncRedis });
				console.log('Saved graph artifacts:', saved);
				return existing;
			}
		} catch {
			// fall through to empty graph generation
		}
	}

	// First pass: collect people and firms
	for (const f of parsedFiles) {
		const { people: p, firms: fo, links: li } = extractPeopleAndFirmsFromHits(f.json || f, employmentOptions);
		for (const [k, v] of p) people.set(k, v);
		for (const [k, v] of fo) firms.set(k, v);
		for (const l of li) links.push(l);
	}

	const firmIdSet = new Set(Array.from(firms.keys()));

	// Helper: recursively search an object for firm ids
	function findFirmIds(obj, out = new Set()) {
		if (!obj) return out;
		if (typeof obj === 'string' || typeof obj === 'number') {
			const s = String(obj).trim();
			if (firmIdSet.has(s)) out.add(s);
			return out;
		}
		if (Array.isArray(obj)) {
			for (const v of obj) findFirmIds(v, out);
			return out;
		}
		if (typeof obj === 'object') {
			for (const v of Object.values(obj)) findFirmIds(v, out);
			return out;
		}
		return out;
	}

	// Heuristic: find firm names in object fields
	function findFirmNames(obj, out = new Set()) {
		if (!obj) return out;
		if (typeof obj === 'string') {
			const s = obj.trim();
			if (s.length > 2 && /firm|broker|bd|broker-dealer|company/i.test(s) && s.length < 120) out.add(s);
			return out;
		}
		if (typeof obj === 'number') return out;
		if (Array.isArray(obj)) {
			for (const v of obj) findFirmNames(v, out);
			return out;
		}
		if (typeof obj === 'object') {
			for (const [k, v] of Object.entries(obj)) {
				if (/firm|firmName|firm_name|broker/i.test(k)) findFirmNames(v, out);
				else findFirmNames(v, out);
			}
			return out;
		}
		return out;
	}

	// Second pass: for each parsed file, if it corresponds to a person, look for firm ids in its content
	for (const f of parsedFiles) {
		const obj = f.json || f;
		// try to find a crd for person
		let crd = null;
		try {
			// Try to extract CRD from the hits
			const hits = obj?.hits?.hits || [];
			for (const hit of hits) {
				const src = hit._source || {};
				if (src.ind_source_id) crd = String(src.ind_source_id);
				else if (src.person && src.person.crd) crd = String(src.person.crd);
				else if (src.content) {
					const c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
					crd = c?.basicInformation?.crd || c?.basicInformation?.individualId;
					if (crd) crd = String(crd);
				}
				if (crd) break; // Found one, stop looking
			}
		} catch (e) {
			crd = null;
		}
		if (crd && people.has(crd)) {
			if (employmentOptions.enableHeuristicEmploymentLinks) {
				const found = findFirmIds(obj);
				for (const fid of found) {
					links.push({ source: personId(crd), target: firmId(fid), relationship: 'employed_by' });
					firms.set(fid, firms.get(fid) || { id: firmId(fid), label: String(fid), group: 'firm' });
				}
				// Heuristic firm names
				const names = findFirmNames(obj);
				for (const nm of names) {
					const slug = nm
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, '_')
						.replace(/^_|_$/g, '');
					const fid = `name:${slug}`;
					links.push({ source: personId(crd), target: firmId(fid), relationship: 'employed_by' });
					firms.set(fid, firms.get(fid) || { id: firmId(fid), label: nm, group: 'firm' });
				}
			}
			// also try parsing content JSON more deeply for employment arrays
			try {
				const hits = obj?.hits?.hits || [];
				for (const hit of hits) {
					const src = hit._source || {};
					let c = null;
					if (src.content) {
						c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
					}
					if (c) {
						const selectedEmps = collectEmploymentRecords(c, employmentOptions);
						for (const e of selectedEmps) {
							const fid = e.firmId || e.firm_id || e.firmId;
							if (fid) {
								links.push({ source: personId(crd), target: firmId(String(fid)), relationship: 'employed_by' });
								firms.set(String(fid), firms.get(String(fid)) || { id: firmId(String(fid)), label: e.firmName || String(fid), group: 'firm' });
							}
						}
					}
				}
			} catch (e) {}
		}
	}

	// Inspect firm files for directOwners → create 'controls' links
	for (const f of parsedFiles) {
		const obj = f.json || f;
		let targetFirm = null;
		try {
			targetFirm =
				obj.firm_id ||
				obj.firmId ||
				obj.firm_bd_sec_number ||
				obj.bdSECNumber ||
				(obj.content &&
					(() => {
						try {
							const c = typeof obj.content === 'string' ? JSON.parse(obj.content) : obj.content;
							return c?.basicInformation?.firmId || c?.basicInformation?.bdSECNumber;
						} catch {
							return null;
						}
					})());
			if (targetFirm) targetFirm = String(targetFirm);
		} catch (e) {
			targetFirm = null;
		}
		if (!targetFirm) continue;
		try {
			const owners = obj.directOwners || [];
			if (Array.isArray(owners) && owners.length) {
				for (const o of owners) {
					// owner may be a firm or a person/entity
					if (o.ownerFirmId) {
						const ofid = String(o.ownerFirmId);
						firms.set(ofid, firms.get(ofid) || { id: firmId(ofid), label: String(ofid), group: 'firm' });
						links.push({ source: firmId(ofid), target: firmId(targetFirm), relationship: 'controls' });
					} else if (o.ownerId || o.ownerPersonId) {
						const pid = String(o.ownerId || o.ownerPersonId);
						people.set(pid, people.get(pid) || { id: personId(pid), label: String(pid), group: 'individual' });
						links.push({ source: personId(pid), target: firmId(targetFirm), relationship: 'controls' });
					} else if (o.ownerName) {
						const slug = String(o.ownerName)
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, '_')
							.replace(/^_|_$/g, '');
						const eid = `entity:${slug}`;
						firms.set(eid, firms.get(eid) || { id: firmId(eid), label: o.ownerName, group: 'entity' });
						links.push({ source: firmId(eid), target: firmId(targetFirm), relationship: 'controls' });
					}
				}
			}
		} catch (e) {}
	}
	// Fallback: if no links discovered, attach first person to a synthetic firm so graph isn't empty
	if (links.length === 0 && people.size > 0) {
		const firstPerson = people.keys().next().value;
		const fid = 'name:unknown_employer';
		firms.set(fid, firms.get(fid) || { id: firmId(fid), label: 'Unknown Employer', group: 'firm' });
		links.push({ source: personId(firstPerson), target: firmId(fid), relationship: 'employed_by' });
	}

	const nodes = [...people.values(), ...firms.values()];
	const dedupedLinks = [];
	const seenLinks = new Set();
	for (const link of links) {
		const source = link.source?.id ?? link.source;
		const target = link.target?.id ?? link.target;
		const type = link.type || link.relationship || '';
		const key = `${source}|${target}|${type}`;
		if (seenLinks.has(key)) continue;
		seenLinks.add(key);
		dedupedLinks.push(normalizeLink(link));
	}

	const mergedNodeMap = new Map();
	for (const node of Array.isArray(existingGraph?.nodes) ? existingGraph.nodes : []) {
		if (!node?.id) continue;
		mergedNodeMap.set(node.id, node);
	}
	for (const node of nodes) {
		if (!node?.id) continue;
		mergedNodeMap.set(node.id, { ...(mergedNodeMap.get(node.id) || {}), ...node });
	}

	const mergedLinks = [];
	const mergedLinkKeys = new Set();
	for (const link of [...(Array.isArray(existingGraph?.links) ? existingGraph.links : []), ...dedupedLinks]) {
		const source = link.source?.id ?? link.source;
		const target = link.target?.id ?? link.target;
		const type = link.type || link.relationship || '';
		const key = `${source}|${target}|${type}`;
		if (mergedLinkKeys.has(key)) continue;
		mergedLinkKeys.add(key);
		mergedLinks.push(normalizeLink(link));
	}

	const mergedNodes = [...mergedNodeMap.values()];
	const graph = {
		nodes: mergedNodes,
		links: mergedLinks,
		meta: {
			generated: new Date().toISOString(),
			totalIndividuals: mergedNodes.filter((node) => node.group === 'individual').length,
			totalFirms: mergedNodes.filter((node) => node.group === 'firm').length,
			totalEntities: mergedNodes.filter((node) => node.group === 'entity').length,
			totalNodes: mergedNodes.length,
			totalLinks: mergedLinks.length,
		},
	};

	console.log('Built nodes=', graph.meta.totalNodes, 'links=', graph.meta.totalLinks);
	const saved = await saveGraphArtifacts(graph, { syncRedis });
	console.log('Saved graph artifacts:', saved);
	return graph;
}

// ── Incremental manifest ────────────────────────────────────────────────────
// Tracks which source files have already been processed so that rebuilds only
// re-parse changed or new files rather than the full corpus each time.
const MANIFEST_FILE = path.join(ROOT, 'data', 'build_manifest.json');

async function readManifest() {
	try {
		return JSON.parse(await fs.readFile(MANIFEST_FILE, 'utf-8'));
	} catch {
		return {};
	}
}

async function writeManifest(manifest) {
	await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function getFileMtime(p) {
	try {
		return (await fs.stat(p)).mtimeMs;
	} catch {
		return 0;
	}
}

async function readJsonFilesIncremental(dir, manifest) {
	const out = [];
	const updated = {};
	try {
		const files = await fs.readdir(dir);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			const p = path.join(dir, f);
			const mtime = await getFileMtime(p);
			updated[p] = mtime;
			if (manifest[p] && manifest[p] === mtime) continue; // unchanged
			try {
				const raw = await fs.readFile(p, 'utf-8');
				out.push({ file: f, json: JSON.parse(raw) });
			} catch {}
		}
	} catch {}
	return { files: out, mtimes: updated };
}

async function buildIncremental(options = {}) {
	const manifest = await readManifest();
	const { files: finraFiles, mtimes: fMtimes } = await readJsonFilesIncremental(FINRA, manifest);
	const { files: secFiles, mtimes: sMtimes } = await readJsonFilesIncremental(SEC, manifest);

	const newFiles = finraFiles.length + secFiles.length;
	if (newFiles === 0) {
		console.log('build_graph_from_cache: no new/changed files — skipping rebuild');
		return;
	}
	console.log(`build_graph_from_cache: ${newFiles} changed file(s) detected — rebuilding graph`);
	await build(options);
	// Update manifest with new mtimes
	const combined = { ...manifest, ...fMtimes, ...sMtimes };
	await writeManifest(combined);
}

if (require.main === module) {
	const argv = require('minimist')(process.argv.slice(2));
	const forceFull = argv.full || argv.f || false;
	const incrementalFlag = argv.incremental || argv.i || false;
	// Default to incremental unless explicit full requested
	const useIncremental = !forceFull && !incrementalFlag;
	const employmentScope = normalizeEmploymentScope(argv['employment-scope'] || argv.employmentScope || 'current');
	const syncRedis = !(argv['no-redis'] || argv.noRedis);
	const employmentOptions = getEmploymentScopeOptions(employmentScope);

	const start = process.hrtime.bigint();
	const runner = useIncremental ? buildIncremental : build;
	console.log(`build_graph_from_cache: starting ${useIncremental ? 'incremental' : 'full'} run`);
	runner({ employmentOptions, syncRedis })
		.then((res) => {
			const end = process.hrtime.bigint();
			const ms = Number(end - start) / 1_000_000;
			console.log(`build_graph_from_cache: completed in ${ms.toFixed(1)}ms`);
			process.exit(0);
		})
		.catch((e) => {
			const end = process.hrtime.bigint();
			const ms = Number(end - start) / 1_000_000;
			console.error(`build_graph_from_cache: failed after ${ms.toFixed(1)}ms`, e);
			process.exit(1);
		});
}

module.exports = {
	build,
	buildIncremental,
	getEmploymentScopeOptions,
	normalizeEmploymentScope,
	buildSeedBankFromGraph,
	saveGraphArtifacts,
	ensureGraphArtifacts,
};
