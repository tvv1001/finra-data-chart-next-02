#!/usr/bin/env node
/**
 * generate-crd-log.js
 *
 * Scans data/raw/ for all finra:firm:<CRD>.json and finra:individual:<CRD>.json
 * files, merges them into data/crd-log.json, and updates counts.
 *
 * The log is additive — CRDs are never removed once recorded.
 * Run any time after new raw files are added.
 *
 * Usage:
 *   node scripts/generate-crd-log.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const LOG_FILE = path.join(ROOT, 'data', 'crd-log.json');

function readExistingLog() {
	if (!fs.existsSync(LOG_FILE)) return { individuals: [], firms: [] };
	try {
		const parsed = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
		return {
			individuals: Array.isArray(parsed.individuals) ? parsed.individuals : [],
			firms: Array.isArray(parsed.firms) ? parsed.firms : [],
		};
	} catch {
		console.warn('Warning: could not parse existing crd-log.json — starting fresh.');
		return { individuals: [], firms: [] };
	}
}

function scanRawDir() {
	const files = fs.readdirSync(RAW_DIR);
	const firms = new Set();
	const individuals = new Set();
	for (const name of files) {
		const firmMatch = name.match(/^finra:firm:(\d+)\.json$/);
		if (firmMatch) { firms.add(Number(firmMatch[1])); continue; }
		const indivMatch = name.match(/^finra:individual:(\d+)\.json$/);
		if (indivMatch) { individuals.add(Number(indivMatch[1])); }
	}
	return { firms, individuals };
}

function main() {
	const existing = readExistingLog();
	const scanned = scanRawDir();

	// Merge — additive only
	const firms = new Set([...existing.firms, ...scanned.firms]);
	const individuals = new Set([...existing.individuals, ...scanned.individuals]);

	const sortedFirms = [...firms].sort((a, b) => a - b);
	const sortedIndividuals = [...individuals].sort((a, b) => a - b);

	const newFirmCount = sortedFirms.length - existing.firms.length;
	const newIndivCount = sortedIndividuals.length - existing.individuals.length;

	const log = {
		updatedAt: new Date().toISOString(),
		summary: {
			firms: sortedFirms.length,
			individuals: sortedIndividuals.length,
			total: sortedFirms.length + sortedIndividuals.length,
		},
		firms: sortedFirms,
		individuals: sortedIndividuals,
	};

	fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n');

	console.log(`crd-log.json updated`);
	console.log(`  firms       : ${sortedFirms.length.toLocaleString()} (+${newFirmCount})`);
	console.log(`  individuals : ${sortedIndividuals.length.toLocaleString()} (+${newIndivCount})`);
	console.log(`  total       : ${log.summary.total.toLocaleString()}`);
}

main();
