#!/usr/bin/env node
/*
Revalidate FINRA/SEC presence for nodes in data/national/finra-graph.json.
- Updates node.hasFinraData and node.hasSecData based on merged endpoints
- Writes a backup and updates the graph file in place
- Writes a report to data/national/revalidate_report_<timestamp>.json

Flags:
  --concurrency=N   (default 6)
  --dry-run         (do not persist changes)
  --node=<nodeId>   Only revalidate a single node id (e.g. person:18040 or firm:18040)
*/

const fs = require('fs').promises;
const path = require('path');
// optional Upstash Redis integration for cache priming and monitoring
let UpstashRedis = null;
try {
	UpstashRedis = require('@upstash/redis').Redis;
} catch (e) {
	UpstashRedis = null;
}

const ROOT = process.cwd();
const NATIONAL = path.join(ROOT, 'data', 'national');
const GRAPH_PATH = path.join(NATIONAL, 'finra-graph.json');

function nowIso() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

const argv = (() => {
	const out = { concurrency: 6, dryRun: false, singleNode: null, limit: null };
	for (const arg of process.argv.slice(2)) {
		const [k, v] = arg.replace(/^--/, '').split('=');
		if (k === 'concurrency') out.concurrency = Math.max(1, Number(v) || 6);
		else if (k === 'dry-run') out.dryRun = true;
		else if (k === 'node') out.singleNode = String(v || '').trim();
		else if (k === 'limit' || k === 'max') out.limit = Number(v) || null;
	}
	return out;
})();

async function fetchJson(url) {
	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.json();
}

async function run() {
	const { concurrency, dryRun, singleNode } = argv;
	let raw;
	try {
		raw = await fs.readFile(GRAPH_PATH, 'utf8');
	} catch (e) {
		console.error('Failed to read graph:', e);
		process.exit(2);
	}
	let graph;
	try {
		graph = JSON.parse(raw);
	} catch (e) {
		console.error('Invalid JSON graph:', e);
		process.exit(2);
	}

	// If local graph is empty but Redis is configured, attempt to read the graph from Redis
	try {
		if ((!graph.nodes || graph.nodes.length === 0) && UpstashRedis) {
			const url = process.env.UPSTASH_REDIS_REST_URL;
			const token = process.env.UPSTASH_REDIS_REST_TOKEN;
			if (url && token) {
				const r = new UpstashRedis({ url, token });
				const rawGraph = await r.get('finra:graph');
				if (rawGraph) {
					try {
						const parsed = JSON.parse(rawGraph);
						if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
							graph = parsed;
							console.log('Loaded graph from Upstash Redis finra:graph');
						}
					} catch (e) {
						// ignore parse errors
					}
				}
			}
		}
	} catch (e) {
		// ignore redis read errors
	}

	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	let candidates = nodes.filter((n) => {
		if (singleNode) return n.id === singleNode;
		return (
			(n.group === 'individual' && (n.crd || (n.basicInformation && n.basicInformation.individualId))) ||
			(n.group === 'firm' && (n.firmId || (n.id && String(n.id).replace(/^firm[:_]/, ''))))
		);
	});

	// apply optional limit to reduce per-run work (helps keep runtime/cost low)
	if (argv.limit && !singleNode) {
		console.log(`Applying limit=${argv.limit} to candidates`);
		candidates = candidates.slice(0, Math.max(0, Number(argv.limit)));
	}

	console.log(`Revalidating ${candidates.length} nodes (concurrency=${concurrency})`);

	const results = [];
	let idx = 0;

	// Init Redis client if configured
	let redis = null;
	try {
		const url = process.env.UPSTASH_REDIS_REST_URL;
		const token = process.env.UPSTASH_REDIS_REST_TOKEN;
		if (UpstashRedis && url && token) redis = new UpstashRedis({ url, token });
	} catch (e) {
		redis = null;
	}

	async function worker() {
		while (true) {
			const i = idx++;
			if (i >= candidates.length) return;
			const node = candidates[i];
			try {
				if (node.group === 'individual') {
					const crd = String(node.crd || (node.basicInformation && node.basicInformation.individualId) || String(node.id || '').replace(/^person[:_]/, '')).trim();
					if (!crd) {
						results.push({ id: node.id, ok: false, reason: 'no-crd' });
						continue;
					}
					const url = `http://localhost:3000/api/finra/merged/individual/${encodeURIComponent(crd)}`;
					// use internal merged endpoint; respect environment if running inside app
					const payload = await fetchJson(url);
					const merged = payload?.merged || null;
					const before = { hasFinraData: node.hasFinraData, hasSecData: node.hasSecData };
					if (merged) {
						if (merged.hasFinraData != null) node.hasFinraData = merged.hasFinraData;
						if (merged.hasSecData != null) node.hasSecData = merged.hasSecData;
					}
					node._externalValidated = new Date().toISOString();

					// If Redis is available, ensure the FINRA individual cache key exists and note monitoring
					try {
						if (redis && crd) {
							const IND_QUERY = 'hl=true&includePrevious=true&wt=json';
							const key = `finra:individual:${crd}:${IND_QUERY}`;
							const existing = await redis.get(key);
							if (!existing) {
								// prime the cache with merged payload (best-effort)
								try {
									await redis.set(key, JSON.stringify(merged), { ex: 60 * 60 * 24 * 7 }); // 7 days
									await redis.lpush('finra:redis-monitor', JSON.stringify({ ts: new Date().toISOString(), node: node.id, crd, action: 'primed-individual-cache', key }));
									await redis.ltrim('finra:redis-monitor', 0, 199);
								} catch (e) {
									// ignore redis set errors
								}
							} else if (existing) {
								await redis.lpush('finra:redis-monitor', JSON.stringify({ ts: new Date().toISOString(), node: node.id, crd, action: 'cache-present' }));
								await redis.ltrim('finra:redis-monitor', 0, 199);
							}
						}
					} catch (e) {
						// ignore monitoring failures
					}
					results.push({ id: node.id, before, after: { hasFinraData: node.hasFinraData, hasSecData: node.hasSecData }, ok: true });
				} else if (node.group === 'firm') {
					const fid = String(node.firmId || String(node.id || '').replace(/^firm[:_]/, '')).trim();
					if (!fid) {
						results.push({ id: node.id, ok: false, reason: 'no-firmid' });
						continue;
					}
					const url = `http://localhost:3000/api/finra/merged/firm/${encodeURIComponent(fid)}`;
					const payload = await fetchJson(url);
					const merged = payload?.merged || null;
					const before = { hasFinraData: node.hasFinraData, hasSecData: node.hasSecData };
					if (merged) {
						if (merged.hasFinraData != null) node.hasFinraData = merged.hasFinraData;
						if (merged.hasSecData != null) node.hasSecData = merged.hasSecData;
					}
					node._externalValidated = new Date().toISOString();

					// If Redis is available, ensure the FINRA firm cache key exists and note monitoring
					try {
						if (redis && fid) {
							const FIRM_QUERY = 'hl=true&wt=json';
							const key = `finra:firm:${fid}:${FIRM_QUERY}`;
							const existing = await redis.get(key);
							if (!existing) {
								try {
									await redis.set(key, JSON.stringify(merged), { ex: 60 * 60 * 24 * 7 });
									await redis.lpush('finra:redis-monitor', JSON.stringify({ ts: new Date().toISOString(), node: node.id, fid, action: 'primed-firm-cache', key }));
									await redis.ltrim('finra:redis-monitor', 0, 199);
								} catch (e) {
									// ignore redis errors
								}
							} else if (existing) {
								await redis.lpush('finra:redis-monitor', JSON.stringify({ ts: new Date().toISOString(), node: node.id, fid, action: 'cache-present' }));
								await redis.ltrim('finra:redis-monitor', 0, 199);
							}
						}
					} catch (e) {
						// ignore monitoring failures
					}
					results.push({ id: node.id, before, after: { hasFinraData: node.hasFinraData, hasSecData: node.hasSecData }, ok: true });
				} else {
					results.push({ id: node.id, ok: false, reason: 'unsupported-group' });
				}
			} catch (err) {
				results.push({ id: node.id, ok: false, reason: String(err && err.message ? err.message : err) });
			}
		}
	}

	const workers = [];
	for (let i = 0; i < concurrency; i++) workers.push(worker());
	await Promise.all(workers);

	const ts = nowIso();
	const reportPath = path.join(NATIONAL, `revalidate_report_${ts}.json`);
	await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary: { total: candidates.length }, results }, null, 2), 'utf8');
	console.log('Wrote report:', reportPath);

	if (!dryRun) {
		// backup and write graph
		const backupPath = path.join(NATIONAL, `finra-graph.json.bak.${ts}`);
		await fs.writeFile(backupPath, raw, 'utf8');
		await fs.writeFile(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf8');
		console.log('Updated graph and wrote backup:', backupPath);
	} else {
		console.log('Dry-run: no changes persisted.');
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
