const { Redis } = require('@upstash/redis');
require('dotenv').config({ path: '.env.local' });

async function checkCRDs() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    console.error('Redis credentials not found in .env.local');
    return;
  }

  const redis = new Redis({ url, token });
  
  console.log('Fetching graph from Redis...');
  
  // Try to read finra:graph. If it's chunked or gzipped, we need to handle it.
  // Actually, graphStore.ts reads it from finra:graph or finra:graph:manifest.
  // We can just use the graphStore.ts logic by running a ts-node script.
}

checkCRDs();
