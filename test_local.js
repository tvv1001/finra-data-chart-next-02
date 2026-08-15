const { Redis } = require('@upstash/redis');
const zlib = require('zlib');
const redis = new Redis({
  url: 'http://127.0.0.1:8080',
  token: 'local-test-token',
});
async function run() {
  const finraRaw = await redis.get('finra:individual:4317416');
  console.log("FINRA in local:", finraRaw ? finraRaw.length : 'null');
  if (typeof finraRaw === 'string' && finraRaw.startsWith('br:')) {
    const d = zlib.brotliDecompressSync(Buffer.from(finraRaw.slice(3), 'base64')).toString();
    const source = JSON.parse(d).hits.hits[0]._source;
    console.log("FINRA content type:", typeof source.content);
  }
}
run();
