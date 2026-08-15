const { Redis } = require('@upstash/redis');
const zlib = require('zlib');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
async function run() {
  const raw = await redis.get('sec:individual:4317416');
  if (typeof raw === 'string' && raw.startsWith('br:')) {
    const decoded = zlib.brotliDecompressSync(Buffer.from(raw.slice(3), 'base64')).toString();
    const data = JSON.parse(decoded);
    const source = data.hits.hits[0]._source;
    const iacontent = JSON.parse(source.iacontent);
    console.log("Type of currentEmployments:", typeof iacontent.currentEmployments);
    if (typeof iacontent.currentEmployments === 'string') {
        console.log("Is it stringified?", iacontent.currentEmployments.slice(0, 50));
    }
  }
}
run();
