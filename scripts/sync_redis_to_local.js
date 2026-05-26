(async () => {
	try {
		const { Redis } = require('@upstash/redis');
		const fs = require('fs');
		const url = process.env.UPSTASH_REDIS_REST_URL;
		const token = process.env.UPSTASH_REDIS_REST_TOKEN;
		if (!url || !token) {
			console.log('NO_UPSTASH_ENV');
			process.exit(0);
		}
		const redis = new Redis({ url, token });
		const key = 'finra:graph';
		const raw = await redis.get(key);
		if (raw == null) {
			console.log('NO_REDIS_KEY');
			process.exit(0);
		}
		let obj;
		try {
			obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
		} catch (e) {
			console.log('PARSE_ERROR', e.message);
			process.exit(0);
		}
		const nodes = (obj.nodes || []).length;
		const links = (obj.links || []).length;
		console.log(JSON.stringify({ fromRedis: { nodes, links, meta: obj.meta || {} } }));
		const localPath = 'data/national/finra-graph.json';
		let local = null;
		try {
			local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
		} catch (e) {
			console.log('LOCAL_READ_ERROR', e.message);
		}
		if (local) {
			console.log(JSON.stringify({ local: { nodes: (local.nodes || []).length, links: (local.links || []).length, meta: local.meta || {} } }));
			if (nodes !== (local.nodes || []).length || links !== (local.links || []).length) {
				const bak = 'data/national/finra-graph.json.bak-from-redis-' + Date.now();
				fs.copyFileSync(localPath, bak);
				fs.writeFileSync(localPath, JSON.stringify(obj, null, 2), 'utf8');
				console.log('UPDATED_LOCAL_FROM_REDIS', bak);
			} else {
				console.log('LOCAL_ALREADY_MATCHES');
			}
		}
	} catch (e) {
		console.error('ERROR', e.message || e);
		process.exit(1);
	}
})();
