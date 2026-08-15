const { Redis } = require('@upstash/redis');
const zlib = require('zlib');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
async function run() {
  const finraRaw = await redis.get('finra:individual:4317416');
  if (typeof finraRaw === 'string' && finraRaw.startsWith('br:')) {
    const d = zlib.brotliDecompressSync(Buffer.from(finraRaw.slice(3), 'base64')).toString();
    const source = JSON.parse(d).hits.hits[0]._source;
    const content = JSON.parse(source.content);
    console.log("FINRA prevEmps:", content.previousEmployments);
  }

  const secRaw = await redis.get('sec:individual:4317416');
  if (typeof secRaw === 'string' && secRaw.startsWith('br:')) {
    const d = zlib.brotliDecompressSync(Buffer.from(secRaw.slice(3), 'base64')).toString();
    const source = JSON.parse(d).hits.hits[0]._source;
    const iacontent = JSON.parse(source.iacontent);
    console.log("SEC prevEmps:", iacontent.previousEmployments);
  }
}
run();
