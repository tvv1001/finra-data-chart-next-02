const { Redis } = require('@upstash/redis');
require('dotenv').config();
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

async function run() {
  console.log("Starting hscan test...");
  let cursor = '0';
  let count = 0;
  do {
    const [nextCursor, elements] = await redis.hscan('search:indexes:extensions:finra:firm', cursor, { count: 1000 });
    cursor = String(nextCursor);
    count += elements.length / 2;
    process.stdout.write(`\rFetched ${count} elements... cursor=${cursor}`);
    if (count > 5000) break; // just a test
  } while (cursor !== '0' && cursor !== '');
  console.log("\nDone!");
  process.exit(0);
}
run().catch(console.error);
