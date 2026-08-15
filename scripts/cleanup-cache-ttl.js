const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function main() {
  let cursor = 0;
  let count = 0;
  console.log('Starting scan for cache keys without TTL...');
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'finra:firm:*', count: 1000 });
    cursor = nextCursor;
    for (const key of keys) {
       const ttl = await redis.ttl(key);
       if (ttl === -1) { // -1 means no expiration
          await redis.expire(key, 86400); // Set to expire in 24 hours
          count++;
       }
    }
  } while (cursor !== 0 && cursor !== '0');
  
  cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'sec:firm:*', count: 1000 });
    cursor = nextCursor;
    for (const key of keys) {
       const ttl = await redis.ttl(key);
       if (ttl === -1) {
          await redis.expire(key, 86400);
          count++;
       }
    }
  } while (cursor !== 0 && cursor !== '0');
  
  cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'finra:individual:*', count: 1000 });
    cursor = nextCursor;
    for (const key of keys) {
       const ttl = await redis.ttl(key);
       if (ttl === -1) {
          await redis.expire(key, 86400);
          count++;
       }
    }
  } while (cursor !== 0 && cursor !== '0');
  
  cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'sec:individual:*', count: 1000 });
    cursor = nextCursor;
    for (const key of keys) {
       const ttl = await redis.ttl(key);
       if (ttl === -1) {
          await redis.expire(key, 86400);
          count++;
       }
    }
  } while (cursor !== 0 && cursor !== '0');

  console.log(`Updated TTL for ${count} keys. They will safely expire over the next 24 hours, freeing up space!`);
}

main().catch(console.error);
