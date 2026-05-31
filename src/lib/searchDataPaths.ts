import * as path from 'node:path';

export const SEARCH_INDEX_FILES = {
	'finra:individual': path.resolve(process.cwd(), 'data', 'national', 'search-index.finra.individual.json'),
	'finra:firm': path.resolve(process.cwd(), 'data', 'national', 'search-index.finra.firm.json'),
	'sec:individual': path.resolve(process.cwd(), 'data', 'national', 'search-index.sec.individual.json'),
	'sec:firm': path.resolve(process.cwd(), 'data', 'national', 'search-index.sec.firm.json'),
} as const;
