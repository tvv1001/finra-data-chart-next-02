#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { normalizeIndividualPayload } = require('./normalizers/finra-normalize');

const ROOT = process.cwd();
const FINRA = path.join(ROOT, 'data', 'national', 'brokercheck.finra.org');
const GRAPH = path.join(ROOT, 'data', 'national', 'finra-graph.json');

async function readJson(p) {
	try {
		return JSON.parse(await fs.readFile(p, 'utf-8'));
	} catch {
		return null;
	}
}

async function main() {
	const graph = await readJson(GRAPH);
	if (!graph) {
		console.error('finra-graph.json not found');
		process.exit(1);
	}
	const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));

	const files = await fs.readdir(FINRA);
	const report = { checked: 0, updated: 0, missingNode: 0, issues: [] };

	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		const p = path.join(FINRA, f);
		let raw;
		try {
			raw = JSON.parse(await fs.readFile(p, 'utf-8'));
		} catch {
			continue;
		}
		const hits = raw?.hits?.hits || [];
		for (const hit of hits) {
			const src = hit._source || {};
			const crd =
				src.ind_source_id ||
				(src.person && src.person.crd) ||
				(src.content &&
					(() => {
						try {
							const c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
							return c?.basicInformation?.crd || c?.basicInformation?.individualId;
						} catch {
							return null;
						}
					})());
			if (!crd) continue;
			report.checked += 1;
			const pid = `person:${String(crd)}`;
			const node = nodeMap.get(pid);
			if (!node) {
				report.missingNode += 1;
				report.issues.push({ crd, problem: 'node_missing' });
				continue;
			}
			// normalize raw content
			let content =
				(src.content &&
					(typeof src.content === 'string' ?
						(() => {
							try {
								return JSON.parse(src.content);
							} catch {
								return null;
							}
						})()
					:	src.content)) ||
				null;
			if (!content) continue;
			const normalized = normalizeIndividualPayload(content);
			// Update person:4240769 explicitly: set label if it's numeric
			if (String(crd) === '4240769') {
				if ((!node.label || /^[0-9]+$/.test(node.label)) && normalized.basicInformation && normalized.basicInformation.displayName) {
					node.label = normalized.basicInformation.displayName;
					node.basicInformation = { ...(node.basicInformation || {}), ...(normalized.basicInformation || {}) };
					node.currentEmployments = normalized.currentEmployments || node.currentEmployments || [];
					report.updated += 1;
				}
			}
			// verify that normalized currentEmployments map to node.currentEmployments (presence check)
			const nodeEmps = Array.isArray(node.currentEmployments) ? node.currentEmployments : [];
			const normEmps = Array.isArray(normalized.currentEmployments) ? normalized.currentEmployments : [];
			for (const ne of normEmps) {
				const found = nodeEmps.some((e) => String(e.firm_id) === String(ne.firm_id) || String(e.firm_bd_sec_number) === String(ne.firm_bd_sec_number));
				if (!found) {
					report.issues.push({ crd, problem: 'employment_mismatch', expected: ne, nodeSample: nodeEmps.slice(0, 3) });
				}
			}
		}
	}

	// write back only if updated
	if (report.updated > 0) {
		await fs.writeFile(GRAPH, JSON.stringify(graph, null, 2), 'utf-8');
		console.log(`Updated ${report.updated} nodes in finra-graph.json`);
	}

	console.log('Mapping verification report:', report);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
