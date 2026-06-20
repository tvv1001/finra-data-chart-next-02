const { Redis } = require('@upstash/redis');

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('Missing UPSTASH env vars');
		process.exit(1);
	}
	const r = new Redis({ url, token });
	console.log('Connected to Upstash Redis');

	const patterns = ['finra:individual:*', 'sec:individual:*', 'finra:firm:*', 'sec:firm:*', 'primed:bundle:*'];
	for (const pattern of patterns) {
		let cursor = '0';
		let count = 0;
		const samples = [];
		do {
			const res = await r.scan(cursor, { MATCH: pattern, COUNT: 2000 });
			cursor = res[0];
			const keys = res[1] || [];
			count += keys.length;
			if (samples.length < 5 && keys.length > 0) {
				samples.push(...keys.slice(0, 5 - samples.length));
			}
		} while (cursor !== '0' && count < 250000);
		console.log(`Pattern ${pattern}: found ${count} keys (Samples: ${JSON.stringify(samples)})`);
	}
}

main().catch(console.error);
