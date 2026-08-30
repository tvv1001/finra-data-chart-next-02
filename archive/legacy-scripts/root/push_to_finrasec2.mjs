import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import fs from 'fs';

const envFile = fs.readFileSync('.env.local', 'utf-8');
const extract = (key) => {
    const match = envFile.match(new RegExp(`${key}="?([^"\\n]+)`));
    return match ? match[1] : null;
};

const upstash = new UpstashRedis({ 
    url: extract('UPSTASH_REDIS_REST_URL_FINRASEC2'), 
    token: extract('UPSTASH_REDIS_REST_TOKEN_FINRASEC2') 
});

const localRedis = new Redis({ db: 0 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
    console.log("Fetching local keys...");
    const keys = await localRedis.keys('*');
    
    // Only push CRD details to save space on the 256MB db
    const detailKeys = keys.filter(k => /^(finra|sec):(individual|firm):\d+$/.test(k));
    console.log(`Found ${detailKeys.length} detail keys to sync to FINRASEC2...`);
    
    let pushed = 0;
    
    for (const key of detailKeys) {
        const val = await localRedis.get(key);
        if (val) {
            try {
                await upstash.set(key, val);
                pushed++;
                if (pushed % 100 === 0) {
                    console.log(`Pushed ${pushed} / ${detailKeys.length} keys to FINRASEC2.`);
                }
                // Sleep to avoid Upstash free tier rate limits (100 req/sec)
                await sleep(25);
            } catch(e) {
                console.error(`Failed pushing ${key}:`, e.message);
                await sleep(1000);
            }
        }
    }
    
    console.log(`Finished pushing ${pushed} keys to FINRASEC2!`);
    localRedis.disconnect();
}

run().catch(console.error);
