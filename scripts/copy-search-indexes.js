#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const dataDir = path.join(root, 'data', 'national');
const publicDestDir = path.join(root, 'public', 'search-indexes');
const nextServerDestDir = path.join(root, '.next', 'server', 'data', 'national');

const files = ['search-index.finra.individual.json', 'search-index.finra.firm.json', 'search-index.sec.individual.json', 'search-index.sec.firm.json'];

// Create destination directories
try {
	fs.mkdirSync(publicDestDir, { recursive: true });
	fs.mkdirSync(nextServerDestDir, { recursive: true });
} catch (err) {
	console.error('Failed to create destination directories:', err.message);
	process.exit(1);
}

let count = 0;
for (const file of files) {
	const src = path.join(dataDir, file);
	const publicDest = path.join(publicDestDir, file);
	const nextServerDest = path.join(nextServerDestDir, file);

	try {
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, publicDest);
			fs.copyFileSync(src, nextServerDest);
			console.log(`✓ Copied ${file}`);
			count++;
		} else {
			console.warn(`⚠ Source not found: ${src}`);
		}
	} catch (err) {
		console.error(`✗ Failed to copy ${file}:`, err.message);
	}
}

console.log(`\nSuccessfully copied ${count}/${files.length} search index files to public/search-indexes/ and .next/server/data/national/`);
