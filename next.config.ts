import type { NextConfig } from 'next';

const graphRuntimeData = [
	'./data/national/finra-graph.json',
	'./data/national/finra-seed-bank.json',
	'./data/national/finra-recent-seeds.json',
	'./data/national/finra-seeds.json',
	'./data/seed-profiles.json',
];

const searchRuntimeData = [
	'./data/national/search-index.finra.individual.json.gz',
	'./data/national/search-index.finra.firm.json.gz',
	'./data/national/search-index.sec.individual.json.gz',
	'./data/national/search-index.sec.firm.json.gz',
];

const primedBinaryRuntimeData = ['./data/national/primed-cache/finra-individual.bin', './data/national/primed-cache/sec-individual.bin'];

const excludedLargeRuntimeData = [
	'data/raw/**',
	'data/cache-binary/**',
	'data/national/brokercheck.finra.org/**',
	'data/national/adviserinfo.sec.gov/**',
	'data/national/primed-cache/**',
	'data/national/*.jsonl',
	'data/national/redis-dump-*.jsonl',
	'data/national/nonstring-finra-keys-*.jsonl',
	'data/national/api.*.json',
	'data/national/search-index*.json',
	'public/search-indexes/**',
	'tests/**',
	'test-results/**',
	'playwright-report/**',
	'coverage/**',
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
		'/api/finra/graph-search': graphRuntimeData,
		'/api/finra/graph-search/route': graphRuntimeData,
		'/api/finra/nodes-by-ids': ['./data/national/finra-graph.json'],
		'/api/finra/prime-check': graphRuntimeData,
		'/api/finra/individual/[crd]': primedBinaryRuntimeData,
		'/api/finra/profile/[name]': ['./data/seed-profiles.json'],
		'/api/finra/recompute-meta': ['./data/national/finra-graph.json'],
		'/api/finra/search': searchRuntimeData,
		'/api/finra/search/route': searchRuntimeData,
		'/api/finra/sec-search': searchRuntimeData,
		'/api/finra/sec-search/route': searchRuntimeData,
		'/api/finra/sec-search-firm': searchRuntimeData,
		'/api/finra/sec-search-firm/route': searchRuntimeData,
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
