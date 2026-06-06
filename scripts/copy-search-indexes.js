#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const dataDir = path.join(root, 'data', 'national');
const destDataDir = path.join(root, '.next', 'data', 'national');

// Files to copy
const filesToCopy = [
	'search-index.finra.individual.json',
	'search-index.finra.firm.json',
	'search-index.sec.individual.json',
	'search-index.sec.firm.json',
];

// Create destination directory
try {
	fs.mkdirSync(destDataDir, { recursive: true });
} catch (err) {
	console.error(`Failed to create directory ${destDataDir}:`, err.message);
	process.exit(1);
}

let copiedCount = 0;

for (const file of filesToCopy) {
	const src = path.join(dataDir, file);
	const dest = path.join(destDataDir, file);
	
	if (fs.existsSync(src)) {
		try {
			fs.copyFileSync(src, dest);
			console.log(`✓ Copied ${file}`);
			copiedCount++;
		} catch (err) {
			console.error(`Failed to copy ${file}:`, err.message);
		}
	} else {
		console.warn(`⚠ Source file not found: ${src}`);
	}
}

console.log(`Successfully copied ${copiedCount} search index files to .next output.`);
