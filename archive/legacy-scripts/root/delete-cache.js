require('dotenv').config({ path: '.env.local' });
const { Redis } = require('@upstash/redis');

// prefer MIRROR env var but fall back to legacy _2 names
const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function main() {
	await redis.del('graph:firm-connections:v4:10111');
	await redis.del('graph:firm-connections:v4:10111:empty');
	console.log('Deleted cache');
}

main().catch(console.error);
