#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const dataDir = path.join(root, 'data', 'national');
const destDir = path.join(root, 'public', 'search-indexes');

const files = [
	'search-index.finra.individual.json',
	'search-index.finra.firm.json',
	'search-index.sec.individual.json',
	'search-index.sec.firm.json',
];

try {
	fs.mkdirSync(destDir, { recursive: true });
} catch (err) {
	console.error(`Failed to create ${destDir}:`, err.message);
	process.exit(1);
}

let count = 0;
for (const file of files) {
	const src = path.join(dataDir, file);
	const dest = path.join(destDir, file);
	try {
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, dest);
			console.log(`✓ Copied ${file}`);
			count++;
		} else {
			console.warn(`⚠ Source not found: ${src}`);
		}
	} catch (err) {
		console.error(`✗ Failed to copy ${file}:`, err.message);
	}
}

console.log(`\nSuccessfully copied ${count}/${files.length} search index files to public/search-indexes/`);
