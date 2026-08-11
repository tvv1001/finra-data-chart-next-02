const { Redis } = require('@upstash/redis');
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
async function run() {
  const keys = await redis.hkeys('search:indexes:extensions:finra:individual');
  const chunk = keys.slice(0, 500);
  const vals = await redis.hmget('search:indexes:extensions:finra:individual', ...chunk);
  console.log('Values count:', Object.values(vals).length);
  process.exit(0);
}
run().catch(console.error);
