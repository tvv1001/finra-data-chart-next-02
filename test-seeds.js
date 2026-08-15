const { getRedisClient } = require('./src/lib/redisCache');
async function run() {
  const redis = getRedisClient();
  if (!redis) return;
  const recent = await redis.get('dashboard:recent-seeds');
  console.log("Recent:", recent);
}
run().catch(console.error);
