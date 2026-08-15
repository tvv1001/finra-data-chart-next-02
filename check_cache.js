const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function run() {
  const data = await redis.get('finra:individual:4317416');
  console.log(JSON.stringify(data, null, 2));
}
run();
