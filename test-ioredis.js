const IORedis = require('ioredis');
const redis = new IORedis('redis://127.0.0.1:6379');
async function test() {
  const keys = await redis.keys('*');
  console.log('Total keys:', keys.length);
  console.log('Sample keys:', keys.slice(0, 10));
  process.exit(0);
}
test();
