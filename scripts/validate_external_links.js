#!/usr/bin/env node
/*
Validate external FINRA / SEC summary URLs for nodes in data/national/finra-graph.json.
- Writes a report to data/national/external_link_validation_<timestamp>.json
- Use --apply to update the graph file and clear hasFinraPage/hasSecPage for unreachable links (creates a backup).

Cron-friendly: exits with 0 on success, non-zero on fatal errors.
*/

const fs = require('fs').promises;
const path = require('path');

const GRAPH_PATH = path.resolve(__dirname, '../data/national/finra-graph.json');
const OUT_DIR = path.resolve(__dirname, '../data/national');
const TIMEOUT_MS = 15000;
const CONCURRENCY = 6;

function nowIso() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

async function safeFetch(url, timeout = TIMEOUT_MS) {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeout);
	try {
		const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
		const text = await res.text();
		clearTimeout(id);
		return { ok: res.ok, status: res.status, body: text };
	} catch (err) {
		clearTimeout(id);
		return { ok: false, status: null, error: String(err) };
	}
}

function isBrokercheckError(body) {
	if (!body) return false;
	return body.includes('There was a problem processing your request') || body.includes('BrokerCheck is temporarily unavailable');
}

async function checkUrl(url) {
	try {
		const r = await safeFetch(url);
		if (!r.ok) return { reachable: false, status: r.status, note: r.error || 'status ' + r.status };
		if (isBrokercheckError(r.body)) return { reachable: false, status: r.status, note: 'brokercheck error page' };
		return { reachable: true, status: r.status };
	} catch (err) {
		return { reachable: false, note: String(err) };
	}
}

async function run() {
	const args = process.argv.slice(2);
	const apply = args.includes('--apply');

	let graphRaw;
	try {
		graphRaw = await fs.readFile(GRAPH_PATH, 'utf8');
	} catch (err) {
		console.error('Unable to read graph file:', GRAPH_PATH, err);
		process.exit(2);
	}

	let graph;
	try {
		graph = JSON.parse(graphRaw);
	} catch (err) {
		console.error('Failed to parse graph JSON:', err);
		process.exit(2);
	}

	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const queue = [];

	for (const n of nodes) {
		// determine possible FINRA/SEC CRD ids
		const firmId = n.firmId || (n.id && String(n.id).replace(/^firm[:_]/, ''));
		const individualId = (n.basicInformation && (n.basicInformation.individualId || n.basicInformation.crd)) || n.individualId || (n.id && String(n.id).replace(/^person[:_]/, ''));

		const items = [];
		if (firmId && (n.hasFinraPage || n.bcScope || n.hasFinraData)) {
			items.push({ type: 'finra-firm', id: firmId, url: `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}` });
		}
		if (individualId && (n.hasFinraPage || n.hasFinraData)) {
			items.push({ type: 'finra-person', id: individualId, url: `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(individualId)}` });
		}
		if (firmId && (n.hasSecPage || n.hasSecData)) {
			items.push({ type: 'sec-firm', id: firmId, url: `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}` });
		}
		if (individualId && (n.hasSecPage || n.hasSecData)) {
			items.push({ type: 'sec-person', id: individualId, url: `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(individualId)}` });
		}

		for (const it of items) {
			queue.push({ nodeId: n.id || null, nodeLabel: n.label || n.name || null, ...it });
		}
	}

	console.log(`Found ${queue.length} external links to validate (from ${nodes.length} nodes)`);

	const results = [];
	// concurrency limiter
	let idx = 0;
	async function worker() {
		while (true) {
			const i = idx++;
			if (i >= queue.length) return;
			const item = queue[i];
			process.stdout.write('.');
			const res = await checkUrl(item.url);
			results.push({ ...item, ...res });
		}
	}

	const workers = [];
	for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
	await Promise.all(workers);
	process.stdout.write('\n');

	const ts = nowIso();
	const reportPath = path.join(OUT_DIR, `external_link_validation_${ts}.json`);
	await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), applyMode: !!apply, results }, null, 2), 'utf8');
	console.log('Wrote report:', reportPath);

	if (apply) {
		// create a backup
		const backupPath = GRAPH_PATH + `.bak.${ts}`;
		await fs.writeFile(backupPath, graphRaw, 'utf8');
		console.log('Created graph backup:', backupPath);

		// mutate graph: clear hasFinraPage / hasSecPage for unreachable
		const unreachableSet = new Set(results.filter((r) => !r.reachable).map((r) => `${r.type}::${r.id}`));
		let changed = 0;
		for (const n of nodes) {
			const firmId = n.firmId || (n.id && String(n.id).replace(/^firm[:_]/, ''));
			const individualId =
				(n.basicInformation && (n.basicInformation.individualId || n.basicInformation.crd)) || n.individualId || (n.id && String(n.id).replace(/^person[:_]/, ''));
			if (firmId) {
				if (unreachableSet.has(`finra-firm::${firmId}`) && n.hasFinraPage) {
					n.hasFinraPage = false;
					changed++;
				}
				if (unreachableSet.has(`sec-firm::${firmId}`) && n.hasSecPage) {
					n.hasSecPage = false;
					changed++;
				}
			}
			if (individualId) {
				if (unreachableSet.has(`finra-person::${individualId}`) && n.hasFinraPage) {
					n.hasFinraPage = false;
					changed++;
				}
				if (unreachableSet.has(`sec-person::${individualId}`) && n.hasSecPage) {
					n.hasSecPage = false;
					changed++;
				}
			}
		}
		if (changed > 0) {
			await fs.writeFile(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf8');
			console.log(`Updated graph file; cleared ${changed} flags.`);
		} else {
			console.log('No changes required to graph file.');
		}
	}

	// exit code: 0 if all reachable or only transient failures (status >= 500) ? For now non-zero if any unreachable
	const unreachableCount = results.filter((r) => !r.reachable).length;
	if (unreachableCount > 0) {
		console.warn(`Found ${unreachableCount} unreachable external links. See report: ${reportPath}`);
		process.exit(3);
	}

	console.log('All checked links appear reachable.');
	process.exit(0);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
