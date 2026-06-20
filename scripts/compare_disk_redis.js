#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();
const EXTERNAL_LOCAL = process.env.LOCAL_DATA_DIR || '/home/lenny/Dev/Data/national';
const fsSync = require('node:fs');
let NATIONAL;
try {
	fsSync.accessSync(EXTERNAL_LOCAL);
	NATIONAL = EXTERNAL_LOCAL;
} catch {
	NATIONAL = path.join(ROOT, 'data', 'national');
}

const DEFAULT_INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const DEFAULT_FIRM_QUERY = 'hl=true&wt=json';

function finraIndividualKey(id) {
	return `finra:individual:${id}:${DEFAULT_INDIVIDUAL_QUERY}`;
}
function finraFirmKey(id) {
	return `finra:firm:${id}:${DEFAULT_FIRM_QUERY}`;
}

async function fileExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function gatherDiskIds() {
	const individualIds = new Set();
	const firmIds = new Set();

	const entries = await fs.readdir(NATIONAL);
	for (const name of entries) {
		if (name.startsWith('finra-individual-') && name.endsWith('.json')) {
			const id = name.replace('finra-individual-', '').replace('.json', '');
			individualIds.add(id);
		}
		if (name.startsWith('finra-firm-') && name.endsWith('.json')) {
			const id = name.replace('finra-firm-', '').replace('.json', '');
			firmIds.add(id);
		}
	}

	const brokerDir = path.join(NATIONAL, 'brokercheck.finra.org');
	if (await fileExists(brokerDir)) {
		const bents = await fs.readdir(brokerDir);
		for (const name of bents) {
			const m = name.match(/^api\.brokercheck\.finra\.org_search_(individual|firm)_(\d+)\.json$/);
			if (m) {
				if (m[1] === 'individual') individualIds.add(m[2]);
				else firmIds.add(m[2]);
			}
			const m2 = name.match(/^firm_(\d+)\.json$/);
			if (m2) firmIds.add(m2[1]);
		}
	}

	const secDir = path.join(NATIONAL, 'adviserinfo.sec.gov');
	if (await fileExists(secDir)) {
		const sents = await fs.readdir(secDir);
		for (const name of sents) {
			const m = name.match(/^api\.adviserinfo\.sec\.gov_search_(individual|firm)_(\d+)\.json$/);
			if (m) {
				if (m[1] === 'individual') individualIds.add(m[2]);
				else firmIds.add(m[2]);
			}
			const m2 = name.match(/^firm_(\d+)\.json$/);
			if (m2) firmIds.add(m2[1]);
		}
	}

	return { individualIds, firmIds };
}

async function gatherRedisIds() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error('UPSTASH env vars required for Redis scan');
	const r = new Redis({ url, token });

	const individualIds = new Set();
	const firmIds = new Set();

	let cursor = '0';
	do {
		const res = await r.scan(cursor, { MATCH: 'finra:individual:*', COUNT: 1000 });
		cursor = res[0];
		const keys = res[1] || [];
		for (const k of keys) {
			const m = k.match(/finra:individual:(\d+)/);
			if (m) individualIds.add(m[1]);
		}
	} while (cursor !== '0');

	cursor = '0';
	do {
		const res = await r.scan(cursor, { MATCH: 'finra:firm:*', COUNT: 1000 });
		cursor = res[0];
		const keys = res[1] || [];
		for (const k of keys) {
			const m = k.match(/finra:firm:(\d+)/);
			if (m) firmIds.add(m[1]);
		}
	} while (cursor !== '0');

	return { individualIds, firmIds };
}

async function main() {
	console.log('Scanning disk at', NATIONAL);
	const disk = await gatherDiskIds();
	console.log('disk counts:', { individuals: disk.individualIds.size, firms: disk.firmIds.size });

	console.log('Scanning Redis (this may take a while)');
	const redis = await gatherRedisIds();
	console.log('redis counts:', { individuals: redis.individualIds.size, firms: redis.firmIds.size });

	const missingIndividual = [];
	for (const id of disk.individualIds) if (!redis.individualIds.has(id)) missingIndividual.push(id);
	const missingFirm = [];
	for (const id of disk.firmIds) if (!redis.firmIds.has(id)) missingFirm.push(id);

	console.log('missing counts:', { individual: missingIndividual.length, firm: missingFirm.length });
	if (missingIndividual.length > 0) console.log('sample missing individuals:', missingIndividual.slice(0, 20));
	if (missingFirm.length > 0) console.log('sample missing firms:', missingFirm.slice(0, 20));

	// write a report JSON
	const out = {
		generatedAt: new Date().toISOString(),
		nationalPath: NATIONAL,
		disk: { individuals: disk.individualIds.size, firms: disk.firmIds.size },
		redis: { individuals: redis.individualIds.size, firms: redis.firmIds.size },
		missing: { individuals: missingIndividual, firms: missingFirm },
	};
	const reportPath = path.join(process.cwd(), 'data', 'national', 'disk-redis-compare-report.json');
	await fs.writeFile(reportPath, JSON.stringify(out, null, 2), 'utf-8');
	console.log('wrote report to', reportPath);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
