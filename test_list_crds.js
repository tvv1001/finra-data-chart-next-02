const { Redis } = require('@upstash/redis');
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
});
redis.get('dashboard:new-crds-cache').then(console.log).catch(console.error);
redis.get('dashboard:cached-crd-count').then(console.log).catch(console.error);
