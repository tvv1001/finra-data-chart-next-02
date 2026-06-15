import type { NextConfig } from 'next';

const seedRuntimeData = ['./data/national/finra-seed-bank.json', './data/national/finra-recent-seeds.json', './data/national/finra-seeds.json', './data/seed-profiles.json'];

const graphRuntimeData = ['./data/national/finra-graph.json', ...seedRuntimeData];
const profileRuntimeData = ['./data/seed-profiles.json'];
const recentSeedRuntimeData = ['./data/national/finra-recent-seeds.json'];
const dashboardRuntimeData = ['./data/crd-log.json', ...graphRuntimeData];

const nextConfig: NextConfig = {
	output: 'standalone',
	// output: "export",
	// Compress API + page responses with gzip/brotli
	compress: true,
	outputFileTracingIncludes: {
		'/api/finra/graph': graphRuntimeData,
		'/api/finra/graph-append': graphRuntimeData,
		'/api/finra/graph-search': graphRuntimeData,
		'/api/finra/prime-check': graphRuntimeData,
		'/api/finra/location-search': graphRuntimeData,
		'/api/finra/nodes-by-ids': graphRuntimeData,
		'/api/finra/cache-stats': graphRuntimeData,
		'/api/finra/recompute-meta': graphRuntimeData,
		'/api/finra/graph-reset': graphRuntimeData,
		'/api/finra/expand/**': graphRuntimeData,
		'/api/finra/health': ['./data/national/finra-graph.json'],
		'/api/finra/seeds': seedRuntimeData,
		'/api/finra/profile/**': profileRuntimeData,
		'/api/finra/add-to-profile': profileRuntimeData,
		'/api/finra/individual/**': recentSeedRuntimeData,
		'/api/finra/firm/**': recentSeedRuntimeData,
		'/api/dashboard/refresh': dashboardRuntimeData,
	},
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
