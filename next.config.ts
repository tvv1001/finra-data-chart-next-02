import type { NextConfig } from 'next';

// Data is served from Redis — exclude all large local data files from serverless bundles.
const allRoutes = '/**';

const nextConfig: NextConfig = {
	output: 'standalone',
	// Compress API + page responses with gzip/brotli
	compress: true,
	outputFileTracingExcludes: {
		[allRoutes]: [
			'./data/national/**',
			'./data/raw/**',
			'./data/primed-cache/**',
			'./data/cache-binary/**',
			'./data/build_manifest.json',
			'./data/crd-log.json',
			'./data/locations.json',
		],
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
