import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';

// We instantiate both clients directly
const upstash1 = new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const upstash2 = new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL_MIRROR, token: process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR });

const localRedis = new Redis({ db: 0 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
    console.log("Fetching local keys...");
    const keys = await localRedis.keys('*');
    const detailKeys = keys.filter(k => /^(finra|sec):(individual|firm):\d+$/.test(k));
    
    console.log(`Found ${detailKeys.length} detail keys to sync to Upstash Prod...`);
    
    let pushed = 0;
    
    // Process in batches
    for (const key of detailKeys) {
        const val = await localRedis.get(key);
        if (val) {
            // Push to both DB1 and Mirror
            try {
                // Run them in parallel
                await Promise.all([
                    upstash1.set(key, val),
                    upstash2.set(key, val)
                ]);
                pushed++;
                
                if (pushed % 100 === 0) {
                    console.log(`Pushed ${pushed} / ${detailKeys.length} keys to Upstash Prod (DB1 & Mirror).`);
                }
                
                // Sleep slightly to avoid 429
                await sleep(10);
            } catch(e) {
                console.error(`Failed pushing ${key}:`, e.message);
                await sleep(1000);
            }
        }
    }
    
    console.log(`Finished pushing ${pushed} keys to Upstash!`);
    localRedis.disconnect();
}

run().catch(console.error);
