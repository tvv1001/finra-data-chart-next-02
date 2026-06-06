#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const dataDir = path.join(root, 'data', 'national');
const publicDestDir = path.join(root, 'public', 'search-indexes');
const nextServerDestDir = path.join(root, '.next', 'server', 'data', 'national');

const files = ['search-index.finra.individual.json.gz', 'search-index.finra.firm.json.gz', 'search-index.sec.individual.json.gz', 'search-index.sec.firm.json.gz'];
const maxChunkSize = 90 * 1024 * 1024; // 90 MB

function writeJsonFile(dest, json) {
	fs.writeFileSync(dest, JSON.stringify(json));
}

function createDestinationDirs() {
	fs.mkdirSync(publicDestDir, { recursive: true });
	fs.mkdirSync(nextServerDestDir, { recursive: true });
}

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
	const prefix = path.basename(file, '.json');

	try {
		if (!fs.existsSync(src)) {
			console.warn(`⚠ Source not found: ${src}`);
			continue;
		}

		const stats = fs.statSync(src);
		if (stats.size <= maxChunkSize) {
			const publicDest = path.join(publicDestDir, file);
			const nextServerDest = path.join(nextServerDestDir, file);
			fs.copyFileSync(src, publicDest);
			fs.copyFileSync(src, nextServerDest);
			console.log(`✓ Copied ${file}`);
			count++;
			continue;
		}

		console.log(`⚡ Splitting ${file} into chunks for deployment (size ${Math.round(stats.size / 1024 / 1024)} MB)`);
		const raw = fs.readFileSync(src, 'utf-8');
		const json = JSON.parse(raw);
		const docs = Array.isArray(json.docs) ? json.docs : [];
		const chunkCount = Math.max(1, Math.ceil(stats.size / maxChunkSize));
		const chunkSize = Math.ceil(docs.length / chunkCount);

		for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
			const chunkDocs = docs.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);
			const chunkFileName = `${prefix}.part${chunkIndex}.json`;
			const chunkJson = {
				generatedAt: json.generatedAt,
				bucket: json.bucket,
				docs: chunkDocs,
			};
			const publicChunkDest = path.join(publicDestDir, chunkFileName);
			const nextServerChunkDest = path.join(nextServerDestDir, chunkFileName);

			writeJsonFile(publicChunkDest, chunkJson);
			writeJsonFile(nextServerChunkDest, chunkJson);
			console.log(`✓ Wrote chunk ${chunkFileName} (${chunkDocs.length} docs)`);
			count++;
		}
	} catch (err) {
		console.error(`✗ Failed to copy or chunk ${file}:`, err.message);
	}
}

console.log(`\nSuccessfully copied/wrote ${count} search index files/chunks to public/search-indexes/ and .next/server/data/national/`);
