#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');
const { DATA_DIR } = { DATA_DIR: path.resolve(process.cwd(), 'data') };
const PRIMED = path.join(DATA_DIR, 'primed-cache');
const OUT = path.join(DATA_DIR, 'national', 'finra-graph.json');

function ensure(v) {
	return v !== undefined && v !== null ? v : undefined;
}

async function readJsonSafe(p) {
	try {
		const raw = await fs.readFile(p, 'utf8');
		return JSON.parse(raw);
	} catch (e) {
		return null;
	}
}

function personNodeFromContent(key, content) {
	const basic = content.basicInformation || {};
	const id = String(basic.individualId || basic.individualId || basic.crd || '').trim();
	if (!id) return null;
	const name = [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ').trim() || content.displayName || content.name || `Person ${id}`;
	return { id: `person:${id}`, label: name, group: 'individual', basicInformation: basic };
}

function firmNodeFromContent(key, content) {
	const basic = content.basicInformation || {};
	const id = String(basic.firmId || content.firmId || content.id || '').trim();
	if (!id) return null;
	const name = String(basic.firmName || content.firmName || content.name || `Firm ${id}`);
	return { id: `firm:${id}`, label: name, group: 'firm', basicInformation: basic };
}

async function build() {
	const nodesMap = new Map();
	const links = [];

	// Helper to add node
	function addNode(node) {
		if (!node || !node.id) return;
		if (!nodesMap.has(node.id)) nodesMap.set(node.id, node);
	}

	// FINRA individuals
	const finraIndividuals = (await readJsonSafe(path.join(PRIMED, 'finra-individual.json'))) || {};
	for (const [k, v] of Object.entries(finraIndividuals)) {
		const content = v && v.content ? v.content : v;
		const pnode = personNodeFromContent(k, content);
		if (pnode) addNode(pnode);

		const collect = (arr, isCurrent) => {
			if (!Array.isArray(arr)) return;
			for (const emp of arr) {
				const firmId = emp && (emp.firmId || emp.firm_id || emp.firmId);
				if (!firmId) continue;
				const fid = String(firmId).trim();
				const fidNodeId = `firm:${fid}`;
				addNode({ id: fidNodeId, label: emp.firmName || `Firm ${fid}`, group: 'firm' });
				links.push({ source: `person:${pnode.id.split(':')[1]}`, target: fidNodeId, relationship: isCurrent ? 'employed_by' : 'previous_employed_by', isCurrent: !!isCurrent });
			}
		};

		collect(content.currentEmployments || content.currentIAEmployments || [], true);
		collect(content.currentIAEmployments || [], true);
		collect(content.previousEmployments || content.previousIAEmployments || [], false);
	}

	// FINRA firms
	const finraFirms = (await readJsonSafe(path.join(PRIMED, 'finra-firm.json'))) || {};
	for (const [k, v] of Object.entries(finraFirms)) {
		const content = v && v.content ? v.content : v;
		const fnode = firmNodeFromContent(k, content);
		if (fnode) addNode(fnode);
	}

	// SEC individuals/firms (optional)
	const secIndividuals = (await readJsonSafe(path.join(PRIMED, 'sec-individual.json'))) || {};
	for (const [k, v] of Object.entries(secIndividuals)) {
		const content = v && v.content ? v.content : v;
		const pnode = personNodeFromContent(k, content);
		if (pnode) addNode(pnode);
		const current = content.currentEmployments || content.previousEmployments || [];
		for (const emp of current) {
			const firmId = emp && (emp.firmId || emp.firm_id || emp.firmId);
			if (!firmId) continue;
			const fid = String(firmId).trim();
			const fidNodeId = `firm:${fid}`;
			addNode({ id: fidNodeId, label: emp.firmName || `Firm ${fid}`, group: 'firm' });
			links.push({ source: `person:${pnode.id.split(':')[1]}`, target: fidNodeId, relationship: 'employed_by', isCurrent: true });
		}
	}

	const nodes = Array.from(nodesMap.values());
	const out = { nodes, links, meta: { generated: new Date().toISOString(), source: 'build_graph_from_cache.js' } };

	await fs.mkdir(path.dirname(OUT), { recursive: true });
	await fs.writeFile(OUT, JSON.stringify(out, null, 2), 'utf8');
	console.log(`Wrote ${OUT} with ${nodes.length} nodes and ${links.length} links`);
}

build().catch((err) => {
	console.error(err);
	process.exit(1);
});
