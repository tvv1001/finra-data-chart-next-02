const { Redis } = require('@upstash/redis');
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
});
async function run() {
    let cursor = '0';
    let count = 0;
    do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: 'finra:individual:*', count: 1000 });
        count += keys.length;
        cursor = nextCursor === '0' || !nextCursor ? '0' : String(nextCursor);
    } while (cursor !== '0');
    cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: 'finra:firm:*', count: 1000 });
        count += keys.length;
        cursor = nextCursor === '0' || !nextCursor ? '0' : String(nextCursor);
    } while (cursor !== '0');
    console.log('Total CRDs:', count);
    await redis.set('dashboard:cached-crd-count', count);
    await redis.del('dashboard:new-crds-cache');
    console.log('Done!');
}
run();
