const Redis = require('ioredis');
const redis = new Redis();
async function run() {
  const keys = await redis.keys('sec:firm:*');
  console.log("Keys matching sec:firm:*", keys);
  redis.disconnect();
}
run().catch(console.error);
