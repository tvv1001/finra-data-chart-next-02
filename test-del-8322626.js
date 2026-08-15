const IORedis = require('ioredis');
const localIoRedis = new IORedis('redis://127.0.0.1:6379');
localIoRedis.del('finra:individual:8322626', 'sec:individual:8322626', 'finra:merged:individual:8322626').then(res => {
  console.log("Deleted", res, "keys");
  process.exit(0);
});
