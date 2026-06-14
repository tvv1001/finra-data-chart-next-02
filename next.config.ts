import type { NextConfig } from 'next';

const graphRuntimeData = [
	'./data/national/finra-graph.json',
	'./data/national/finra-seed-bank.json',
	'./data/national/finra-recent-seeds.json',
	'./data/national/finra-seeds.json',
	'./data/seed-profiles.json',
];

const excludedLargeRuntimeData = [
	'data/raw/**',
	'data/cache-binary/**',
	'data/build_manifest.json',
	'data/national/brokercheck.finra.org/**',
	'data/national/adviserinfo.sec.gov/**',
	'data/national/primed-cache/**',
	'data/national/finra-graph*.json*',
	'data/national/finra-seed-bank.json',
	'data/national/finra-seeds.json',
	'data/national/finra-recent-seeds.json',
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
	output: 'standalone',
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
	experimental: {
		// Allow huge graph JSON to be serialised through getServerSideProps / route handlers
		largePageDataBytes: 128 * 1024 * 1024, // 128 MB
	},
};

export default nextConfig;
