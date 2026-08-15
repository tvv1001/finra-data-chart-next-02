const { GET } = require('./.next/server/app/api/finra/merged/individual/[crd]/route.js');

async function run() {
	const req = { url: 'http://localhost/api/finra/merged/individual/4317416', headers: { get: () => null } };
	// Mock NextRequest
	class MockRequest {
		constructor(url) {
			this.url = url;
			this.nextUrl = new URL(url);
			this.headers = new Map();
		}
	}
	const res = await GET(new MockRequest('http://localhost/api/finra/merged/individual/4317416'), { params: Promise.resolve({ crd: '4317416' }) });
	const json = await res.json();
	console.log(JSON.stringify(json.merged, null, 2));
}
run();
