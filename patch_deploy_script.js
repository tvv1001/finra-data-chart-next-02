const fs = require('fs');

let content = fs.readFileSync('scripts/deploy-search-indexes-to-redis.js', 'utf-8');

// We need to add logic to read UPSTASH_REDIS_REST_URL_MIRROR and push to it
content = content.replace(
    /const redisUrl = process\.env\.UPSTASH_REDIS_REST_URL \|\| envVars\.UPSTASH_REDIS_REST_URL;/g,
    `const redisUrl = process.env.UPSTASH_REDIS_REST_URL || envVars.UPSTASH_REDIS_REST_URL;\nconst redisUrlMirror = process.env.UPSTASH_REDIS_REST_URL_MIRROR || envVars.UPSTASH_REDIS_REST_URL_MIRROR;`
);

content = content.replace(
    /const redisToken = process\.env\.UPSTASH_REDIS_REST_TOKEN \|\| envVars\.UPSTASH_REDIS_REST_TOKEN;/g,
    `const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || envVars.UPSTASH_REDIS_REST_TOKEN;\nconst redisTokenMirror = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || envVars.UPSTASH_REDIS_REST_TOKEN_MIRROR;`
);

content = content.replace(
    /async function send\(command\) \{([\s\S]*?)\}/,
    `async function send(command) {
			const promises = [];
			promises.push(
				fetch(redisUrl, {
					method: 'POST',
					headers: { Authorization: \`Bearer \${redisToken}\`, 'Content-Type': 'application/json' },
					body: JSON.stringify(command)
				}).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
			);
			
			if (redisUrlMirror && redisTokenMirror) {
				promises.push(
					fetch(redisUrlMirror, {
						method: 'POST',
						headers: { Authorization: \`Bearer \${redisTokenMirror}\`, 'Content-Type': 'application/json' },
						body: JSON.stringify(command)
					}).then(async r => { if (!r.ok) console.warn("Mirror error:", await r.text()); return r.json(); }).catch(e => console.warn("Mirror fail", e))
				);
			}
			
			const results = await Promise.all(promises);
			return results[0];
		}`
);

fs.writeFileSync('scripts/deploy-search-indexes-to-redis.js', content);
