const { getRedisClientInstance } = require('./src/lib/redisClient.ts');
const r = getRedisClientInstance({url:'', token:''});
r.get('finra:firm:290327').then(v => console.log(typeof v, v && v.slice ? v.slice(0,20) : v)).catch(console.error);
