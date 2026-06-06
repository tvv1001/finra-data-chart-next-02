import { existsSync } from 'node:fs';
import * as path from 'node:path';

export const SEARCH_INDEX_RELATIVE_FILES = {
	'finra:individual': path.join('data', 'national', 'search-index.finra.individual.json'),
	'finra:firm': path.join('data', 'national', 'search-index.finra.firm.json'),
	'sec:individual': path.join('data', 'national', 'search-index.sec.individual.json'),
	'sec:firm': path.join('data', 'national', 'search-index.sec.firm.json'),
} as const;

type SearchIndexBucket = keyof typeof SEARCH_INDEX_RELATIVE_FILES;

// Get the directory where this module is located
// This is needed because __dirname is not reliably available in ES modules
let moduleDir: string;
try {
	// Try to use __dirname if available (CommonJS-like)
	moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
} catch {
	moduleDir = process.cwd();
}

function addRootAndParents(roots: Set<string>, startPath?: string | null) {
	if (!startPath) return;

	let currentPath = path.resolve(startPath);
	for (let depth = 0; depth < 8; depth += 1) {
		roots.add(currentPath);
		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) break;
		currentPath = parentPath;
	}
}

function getCandidateRoots(seedRoots: Array<string | null | undefined> = []) {
	const roots = new Set<string>();
	for (const seedRoot of seedRoots) addRootAndParents(roots, seedRoot);
	if (!seedRoots.length) {
		// Always start from module directory first (most reliable on Vercel)
		addRootAndParents(roots, moduleDir);
		// Then try process.cwd()
		addRootAndParents(roots, process.cwd());
		// Include launcher directory
		addRootAndParents(roots, process.argv?.[1] ? path.dirname(process.argv[1]) : null);
	}
	return Array.from(roots);
}

export function getSearchIndexFilePath(bucket: SearchIndexBucket, seedRoots: Array<string | null | undefined> = []) {
	const relativeFilePath = SEARCH_INDEX_RELATIVE_FILES[bucket];
	const candidates = getCandidateRoots(seedRoots);

	for (const root of candidates) {
		const candidatePath = path.resolve(root, relativeFilePath);
		if (existsSync(candidatePath)) {
			console.log(`[searchDataPaths] Found ${bucket} at: ${candidatePath}`);
			return candidatePath;
		}
	}

	console.warn(`[searchDataPaths] No file found for ${bucket}. Checked roots:`, candidates.slice(0, 3));
	return path.resolve(process.cwd(), relativeFilePath);
}
