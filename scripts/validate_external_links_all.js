#!/usr/bin/env node
// Validate FINRA/SEC links for all nodes that have firmId or personId, ignoring presence flags.
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const GRAPH_PATH = path.resolve(__dirname, '../data/national/finra-graph.json');
const OUT_DIR = path.resolve(__dirname, '../data/national');

function nowIso() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

async function safeFetch(url, timeout = 15000) {
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

async function retryFetch(url, attempts = 3) {
	let last = null;
	for (let i = 0; i < attempts; i++) {
		last = await safeFetch(url);
		if (last.ok) return { result: last, attempts: i + 1 };
		await new Promise((r) => setTimeout(r, 1500));
	}
	return { result: last, attempts: attempts };
}

function isBrokercheckError(body) {
	if (!body) return false;
	return body.includes('There was a problem processing your request') || body.includes('BrokerCheck is temporarily unavailable');
}

async function checkExternalForItem(item) {
	const apiUrl = item.apiUrl || item.url;
	let htmlUrl = null;
	if (item.type && item.type.startsWith('finra')) {
		if (item.type === 'finra-person') htmlUrl = `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(item.id)}`;
		if (item.type === 'finra-firm') htmlUrl = `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(item.id)}`;
	}
	if (item.type && item.type.startsWith('sec')) {
		if (item.type === 'sec-person') htmlUrl = `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(item.id)}`;
		if (item.type === 'sec-firm') htmlUrl = `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(item.id)}`;
	}
	const apiCheck = await retryFetch(apiUrl);
	const apiRes = apiCheck.result || { ok: false, status: null, error: 'no-response' };
	const apiOk = !!(apiRes && apiRes.ok && !isBrokercheckError(apiRes.body));
	let htmlRes = null;
	let htmlOk = false;
	if (htmlUrl) {
		const htmlCheck = await retryFetch(htmlUrl);
		htmlRes = htmlCheck.result;
		htmlOk = !!(htmlRes && htmlRes.ok && !isBrokercheckError(htmlRes.body));
	}
	return { item, api: apiRes, apiOk, html: htmlRes, htmlOk };
}

async function run() {
	const raw = await fs.readFile(GRAPH_PATH, 'utf8');
	const graph = JSON.parse(raw);
	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const queue = [];
	for (const n of nodes) {
		const firmId = n.firmId || (n.id && String(n.id).replace(/^firm[:_]/, ''));
		const individualId = (n.basicInformation && (n.basicInformation.individualId || n.basicInformation.crd)) || n.individualId || (n.id && String(n.id).replace(/^person[:_]/, ''));
		if (firmId) {
			queue.push({
				nodeId: n.id || null,
				type: 'finra-firm',
				id: firmId,
				apiUrl: `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(firmId)}?wt=json`,
				url: `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}`,
			});
			queue.push({
				nodeId: n.id || null,
				type: 'sec-firm',
				id: firmId,
				apiUrl: `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(firmId)}?wt=json`,
				url: `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}`,
			});
		}
		if (individualId) {
			queue.push({
				nodeId: n.id || null,
				type: 'finra-person',
				id: individualId,
				apiUrl: `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(individualId)}?wt=json`,
				url: `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(individualId)}`,
			});
			queue.push({
				nodeId: n.id || null,
				type: 'sec-person',
				id: individualId,
				apiUrl: `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(individualId)}?wt=json`,
				url: `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(individualId)}`,
			});
		}
	}
	console.log(`Validating ${queue.length} items...`);
	const results = [];
	for (const it of queue) {
		process.stdout.write('.');
		const res = await checkExternalForItem(it);
		results.push(res);
	}
	process.stdout.write('\n');
	const ts = nowIso();
	const out = path.join(OUT_DIR, `external_link_validation_all_${ts}.json`);
	await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');
	console.log('Wrote:', out);
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
