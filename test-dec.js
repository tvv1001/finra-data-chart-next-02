const Redis = require('ioredis');
const zlib = require('zlib');
const redis = new Redis();
redis.get('finra:firm:79').then(val => {
  let json = val;
  if (val.startsWith('br:')) {
    const buf = Buffer.from(val.slice(3), 'base64');
    json = zlib.brotliDecompressSync(buf).toString('utf-8');
  }
  const obj = JSON.parse(json);
  console.log(JSON.stringify(obj.hits.hits[0], null, 2));
}).finally(() => redis.quit());
