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
    console.log(JSON.stringify(JSON.parse(decoded), null, 2));
  } else {
    console.log(raw);
  }
}
run();
