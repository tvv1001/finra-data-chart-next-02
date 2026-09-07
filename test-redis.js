const { Redis } = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 6379, retryStrategy: () => null });
redis.ping().then(console.log).catch(console.error).finally(() => redis.quit());
