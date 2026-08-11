const IORedis = require('ioredis');
const r = new IORedis('redis://127.0.0.1:6379');
r.hlen('search:indexes:extensions:finra:firm').then(len => {
  console.log("Length of hash:", len);
  process.exit(0);
});
