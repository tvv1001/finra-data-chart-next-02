const { Redis } = require('@upstash/redis');
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
});
redis.zrange('dashboard:highest-crds:individual', 0, 19, { rev: true }).then(console.log).catch(console.error);
