const { getRedisClient } = require('./src/lib/redisCache');
async function run() {
  const redis = getRedisClient();
  const finra = await redis.get('finra:firm:47249');
  const sec = await redis.get('sec:firm:47249');
  console.log("FINRA:", finra ? (typeof finra === 'string' ? finra : JSON.stringify(finra)).substring(0, 150) : null);
  console.log("SEC:", sec ? (typeof sec === 'string' ? sec : JSON.stringify(sec)).substring(0, 150) : null);
}
run().catch(console.error);
