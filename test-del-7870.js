const IORedis = require('ioredis');
const localIoRedis = new IORedis('redis://127.0.0.1:6379');
localIoRedis.del('finra:firm:7870', 'finra:merged:firm:7870', 'sec:firm:7870', 'sec:merged:firm:7870').then(res => {
  console.log("Deleted", res, "keys");
  process.exit(0);
});
