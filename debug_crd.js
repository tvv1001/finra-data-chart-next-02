const { cachedFetch } = require('./.next/server/app/api/finra/individual/[crd]/route.js') || {};
const { getMergedIndividual } = require('./.next/server/app/api/finra/merged/individual/[crd]/route.js') || {};

async function run() {
	try {
		const res = await fetch('http://localhost:4444/api/finra/merged/individual/4317416');
		const data = await res.json();
		console.log(JSON.stringify(data.individual, null, 2));
	} catch (e) {
		console.error(e);
	}
}
run();
