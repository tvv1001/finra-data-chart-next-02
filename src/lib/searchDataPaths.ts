import { existsSync } from 'node:fs';
import * as path from 'node:path';

export const SEARCH_INDEX_RELATIVE_FILES = {
	'finra:individual': path.join('data', 'national', 'search-index.finra.individual.json'),
	'finra:firm': path.join('data', 'national', 'search-index.finra.firm.json'),
	'sec:individual': path.join('data', 'national', 'search-index.sec.individual.json'),
	'sec:firm': path.join('data', 'national', 'search-index.sec.firm.json'),
} as const;

type SearchIndexBucket = keyof typeof SEARCH_INDEX_RELATIVE_FILES;

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
		addRootAndParents(roots, process.cwd());
		addRootAndParents(roots, typeof __dirname === 'string' ? __dirname : null);
		addRootAndParents(roots, process.argv?.[1] ? path.dirname(process.argv[1]) : null);
	}
	return Array.from(roots);
}

export function getSearchIndexFilePath(bucket: SearchIndexBucket, seedRoots: Array<string | null | undefined> = []) {
	const relativeFilePath = SEARCH_INDEX_RELATIVE_FILES[bucket];
	for (const root of getCandidateRoots(seedRoots)) {
		const candidatePath = path.resolve(root, relativeFilePath);
		if (existsSync(candidatePath)) return candidatePath;
	}

	return path.resolve(process.cwd(), relativeFilePath);
}
