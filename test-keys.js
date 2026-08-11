const IORedis = require('ioredis');
const r = new IORedis('redis://127.0.0.1:6379');
r.keys('finra:firm:*').then(keys => {
  console.log("Number of keys:", keys.length);
  console.log("Sample keys:", keys.slice(0, 5));
  process.exit(0);
});
