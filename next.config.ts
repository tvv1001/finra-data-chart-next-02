import type { NextConfig } from 'next';

const graphRuntimeData = [
	'./data/national/finra-graph.json',
	'./data/national/finra-seed-bank.json',
	'./data/national/finra-recent-seeds.json',
	'./data/national/finra-seeds.json',
	'./data/seed-profiles.json',
];

const searchRuntimeData = [
	'./data/national/search-index.finra.individual.json',
	'./data/national/search-index.finra.firm.json',
	'./data/national/search-index.sec.individual.json',
	'./data/national/search-index.sec.firm.json',
];

const finraSearchRuntimeData = ['./data/national/search-index.finra.individual.json', './data/national/search-index.finra.firm.json'];

const secSearchRuntimeData = ['./data/national/search-index.sec.individual.json', './data/national/search-index.sec.firm.json'];

const primedBinaryRuntimeData = [
	'./data/national/primed-cache/finra-individual.bin',
	'./data/national/primed-cache/sec-individual.bin',
	'./data/national/primed-cache/finra-firm.bin',
	'./data/national/primed-cache/sec-firm.bin',
];

const excludedLargeRuntimeData = [
	'./data/raw/**',
	'./data/cache-binary/**',
	'./data/national/brokercheck.finra.org/**',
	'./data/national/adviserinfo.sec.gov/**',
	'./data/national/primed-cache/**',
	'./data/national/api.*.json',
	'./tests/**',
	'./test-results/**',
	'./playwright-report/**',
	'./coverage/**',
];

const nextConfig: NextConfig = {
	// output: "export",
	// Compress API + page responses with gzip/brotli
	compress: true,
	async rewrites() {
		return [
			{
				source: '/node/:nodeId',
				destination: '/',
			},
		];
	},
	outputFileTracingIncludes: {
		'/api/finra/add-to-profile': ['./data/seed-profiles.json'],
		'/api/finra/cache-stats': ['./data/national/finra-graph.json', './data/national/finra-seed-bank.json'],
		'/api/finra/expand/[nodeId]': ['./data/national/finra-graph.json'],
		'/api/finra/firm/[id]': primedBinaryRuntimeData,
		'/api/finra/graph': graphRuntimeData,
		'/api/finra/graph-append': ['./data/national/finra-graph.json'],
		'/api/finra/graph-search': [...graphRuntimeData, ...searchRuntimeData],
		'/api/finra/nodes-by-ids': ['./data/national/finra-graph.json'],
		'/api/finra/prime-check': graphRuntimeData,
		'/api/finra/individual/[crd]': primedBinaryRuntimeData,
		'/api/finra/profile/[name]': ['./data/seed-profiles.json'],
		'/api/finra/recompute-meta': ['./data/national/finra-graph.json'],
		'/api/finra/search': finraSearchRuntimeData,
		'/api/finra/sec-search': ['./data/national/search-index.sec.individual.json'],
		'/api/finra/sec-search-firm': ['./data/national/search-index.sec.firm.json'],
		'/api/finra/seeds': ['./data/national/finra-seeds.json', './data/seed-profiles.json'],
	},
	outputFileTracingExcludes: {
		'/*': excludedLargeRuntimeData,
	},
	experimental: {
		// Allow huge graph JSON to be serialised through getServerSideProps / route handlers
		largePageDataBytes: 128 * 1024 * 1024, // 128 MB
	},
};

export default nextConfig;
