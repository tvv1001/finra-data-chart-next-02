const { getRedisClient } = require('./src/lib/redisCache');
async function run() {
  const redis = getRedisClient();
  const finra = await redis.get('finra:firm:47249');
  const sec = await redis.get('sec:firm:47249');
  console.log("FINRA:", finra ? finra.substring(0, 150) : null);
  console.log("SEC:", sec ? sec.substring(0, 150) : null);
}
run().catch(console.error);
