#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

// Usage: node scripts/upload_to_local_redis_db1.js [--dry-run] [--force]
const isDryRun = process.argv.includes('--dry-run');
const isForce = process.argv.includes('--force');
const BATCH_SIZE = 20;

const redis = new Redis('redis://127.0.0.1:6379');

const ROOT = process.cwd();
const NATIONAL = path.join(ROOT, 'data', 'national');

function finraIndividualKey(id) {
	return `finra:individual:${id}`;
}
function finraFirmKey(id) {
	return `finra:firm:${id}`;
}
function secIndividualKey(id) {
	return `sec:individual:${id}`;
}
function secFirmKey(id) {
	return `sec:firm:${id}`;
}

function normalizeId(value) {
	return String(value || '')
		.trim()
		.replace(/^person[:_]/i, '')
		.replace(/^firm[:_]/i, '');
}

async function processInBatches(items, batchSize, fn) {
	for (let i = 0; i < items.length; i += batchSize) {
		await Promise.all(items.slice(i, i + batchSize).map(fn));
	}
}

async function uploadFile(filePath, key) {
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (!isForce) {
			const exists = await redis.get(key);
			if (exists != null) {
				// if identical, skip
				if (exists === JSON.stringify(parsed)) return 'unchanged';
				// otherwise fallthrough to overwrite
			}
		}
		if (!isDryRun) {
			// ensure we are using DB 1
			await redis.select(1);
			await redis.set(key, JSON.stringify(parsed)); // no TTL => persist until deleted
		}
		return 'written';
	} catch (err) {
		console.error('error uploading', filePath, err.message);
		return 'error';
	}
}

async function main() {
	let written = 0,
		unchanged = 0,
		skipped = 0,
		errors = 0;

	// top-level finra-individual-*.json files
	const topEntries = fs.readdirSync(NATIONAL).filter((f) => f.endsWith('.json'));
	const indivFiles = topEntries.filter((name) => /^finra-individual-\d+\.json$/.test(name));
	const items = [];
	for (const name of indivFiles) {
		const id = name.replace(/^finra-individual-/, '').replace(/\.json$/, '');
		items.push({ filePath: path.join(NATIONAL, name), key: finraIndividualKey(id) });
	}

	// brokercheck and adviserinfo folders
	const brokersDir = path.join(NATIONAL, 'brokercheck.finra.org');
	if (fs.existsSync(brokersDir)) {
		const files = fs.readdirSync(brokersDir).filter((f) => f.endsWith('.json'));
		for (const name of files) {
			let match = name.match(/^api\.brokercheck\.finra\.org_search_(individual|firm)_(\d+)\.json$/i);
			if (match) {
				const type = match[1];
				const id = match[2];
				const key = type === 'individual' ? finraIndividualKey(id) : finraFirmKey(id);
				items.push({ filePath: path.join(brokersDir, name), key });
			} else if (/^firm_\d+\.json$/i.test(name)) {
				const id = name.replace(/^firm_/, '').replace(/\.json$/, '');
				items.push({ filePath: path.join(brokersDir, name), key: finraFirmKey(id) });
			}
		}
	}

	const secDir = path.join(NATIONAL, 'adviserinfo.sec.gov');
	if (fs.existsSync(secDir)) {
		const files = fs.readdirSync(secDir).filter((f) => f.endsWith('.json'));
		for (const name of files) {
			let match = name.match(/^api\.adviserinfo\.sec\.gov_search_(individual|firm)_(\d+)\.json$/i);
			if (match) {
				const type = match[1];
				const id = match[2];
				const key = type === 'individual' ? secIndividualKey(id) : secFirmKey(id);
				items.push({ filePath: path.join(secDir, name), key });
			} else if (/^firm_\d+\.json$/i.test(name)) {
				const id = name.replace(/^firm_/, '').replace(/\.json$/, '');
				items.push({ filePath: path.join(secDir, name), key: secFirmKey(id) });
			}
		}
	}

	console.log(`Uploading ${items.length} items to local Redis DB 1 (dry-run=${isDryRun}, force=${isForce})`);

	await processInBatches(items, BATCH_SIZE, async ({ filePath, key }) => {
		const res = await uploadFile(filePath, key);
		if (res === 'written') written++;
		else if (res === 'unchanged') unchanged++;
		else if (res === 'error') errors++;
	});

	console.log(`done. written=${written} unchanged=${unchanged} errors=${errors}`);
	redis.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
