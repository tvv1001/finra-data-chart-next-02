import type { NextConfig } from 'next';

const bundledRuntimeData = ['./data/national/**/*.json', './data/seed-profiles.json'];

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
		'/*': bundledRuntimeData,
		'/api/finra/prime-check': bundledRuntimeData,
	},
	experimental: {
		// Allow huge graph JSON to be serialised through getServerSideProps / route handlers
		largePageDataBytes: 128 * 1024 * 1024, // 128 MB
	},
};

export default nextConfig;
