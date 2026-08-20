const Redis = require('ioredis');
const redis = new Redis();
async function run() {
  const data = await redis.get('sec:firm:164289_brokers:previous');
  console.log(data);
  redis.disconnect();
}
run().catch(console.error);
