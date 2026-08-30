const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf-8');
const url = env.match(/UPSTASH_REDIS_REST_URL="(.*)"/)[1];
const token = env.match(/UPSTASH_REDIS_REST_TOKEN="(.*)"/)[1];
async function run() {
  const res = await fetch(`${url}/KEYS/*brokers*`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  console.log("Keys matching *brokers*", data);
}
run().catch(console.error);
