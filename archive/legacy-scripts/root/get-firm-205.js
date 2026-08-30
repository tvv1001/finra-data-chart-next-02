const { getRedisClient } = require('./src/lib/redisCache');
async function run() {
  const redis = getRedisClient();
  const raw = await redis.get('finra:firm:205');
  console.log(JSON.stringify(JSON.parse(raw), null, 2));
}
run().catch(console.error);
