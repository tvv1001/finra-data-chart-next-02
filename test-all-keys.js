const IORedis = require('ioredis');
const r = new IORedis('redis://127.0.0.1:6379');
r.keys('*').then(keys => {
  console.log("Total keys:", keys.length);
  console.log("Sample keys:", keys.slice(0, 20));
  process.exit(0);
});
