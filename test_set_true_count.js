const { Redis } = require('@upstash/redis');
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
});
async function run() {
    await redis.set('dashboard:cached-crd-count', 32596);
    await redis.del('dashboard:new-crds-cache');
    console.log('Set true count to 32596');
}
run();
