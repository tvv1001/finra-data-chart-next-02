#!/usr/bin/env node
/* Batch merge all finra:individual:<id>.json and sec:individual:<id>.json files
   Writes merged JSON to data/derived/merged-individual-<id>.json
*/
const fs = require('fs');
const path = require('path');
const { merge, readJson } = require('./merge_individual_records');

const rawDir = path.resolve(__dirname, '..', 'data', 'raw');
const outDir = path.resolve(__dirname, '..', 'data', 'derived');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(rawDir);
const finraFiles = files.filter((f) => f.startsWith('finra:individual:') && f.endsWith('.json'));
const secFiles = new Set(files.filter((f) => f.startsWith('sec:individual:') && f.endsWith('.json')));

for (const ff of finraFiles) {
	const id = ff.replace('finra:individual:', '').replace('.json', '');
	const finraPath = path.join(rawDir, ff);
	const secName = `sec:individual:${id}.json`;
	const secPath = secFiles.has(secName) ? path.join(rawDir, secName) : null;
	const finra = readJson(finraPath);
	const sec = secPath ? readJson(secPath) : null;
	const merged = merge(finra, sec);
	const outPath = path.join(outDir, `merged-individual-${id}.json`);
	fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');
	console.log('Wrote', outPath);
}
