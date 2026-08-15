const { getRedisClient } = require('./src/lib/redisCache');
async function run() {
  const redis = getRedisClient();
  const keysStrInd = await redis.keys('finra:individual:*');
  const keysStrFirm = await redis.keys('finra:firm:*');
  console.log("ind:", keysStrInd.slice(0, 5));
  console.log("firm:", keysStrFirm.slice(0, 5));
}
run().catch(console.error);
