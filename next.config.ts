import type { NextConfig } from 'next';

// Only bundle the small, curated seed profiles at build time.
// Avoid bundling the entire `data/national` JSON dump which can be very large
// and prevents opening/editing neighboring files in some editors.
const bundledRuntimeData = ['./data/seed-profiles.json'];

const nextConfig: NextConfig = {
	// Allow Playwright dev server origin to make _next resource requests during tests
	// See: Next.js allowedDevOrigins for dev-only cross-origin requests
	allowedDevOrigins: ['http://127.0.0.1:4444', 'http://localhost:4444'],
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
		// Allow Playwright dev server origin during tests in experimental block as well
		allowedDevOrigins: ['http://127.0.0.1:4444', 'http://localhost:4444'],
		// Allow huge graph JSON to be serialised through getServerSideProps / route handlers
		largePageDataBytes: 128 * 1024 * 1024, // 128 MB
	},
};

export default nextConfig;
