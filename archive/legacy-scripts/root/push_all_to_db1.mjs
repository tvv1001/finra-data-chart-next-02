import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import fs from 'fs';

const envFile = fs.readFileSync('.env.local', 'utf-8');
const extract = (key) => {
    const match = envFile.match(new RegExp(`${key}="?([^"\\n]+)`));
    return match ? match[1] : null;
};

// Target DB1 directly
const upstash1 = new UpstashRedis({ 
    url: extract('UPSTASH_REDIS_REST_URL'), 
    token: extract('UPSTASH_REDIS_REST_TOKEN') 
});

const localRedis = new Redis({ db: 0 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
    console.log("Fetching all local keys...");
    const keys = await localRedis.keys('*');
    
    console.log(`Found ${keys.length} total keys to sync to DB1...`);
    
    let pushed = 0;
    
    for (const key of keys) {
        const val = await localRedis.get(key);
        if (val !== null) {
            try {
                await upstash1.set(key, val);
                pushed++;
                
                if (pushed % 250 === 0) {
                    console.log(`Pushed ${pushed} / ${keys.length} keys to DB1.`);
                }
                
                // Sleep slightly to avoid 429
                await sleep(5);
            } catch(e) {
                console.error(`Failed pushing ${key}:`, e.message);
                await sleep(500);
            }
        }
    }
    
    console.log(`Finished pushing ${pushed} total keys to DB1!`);
    localRedis.disconnect();
}

run().catch(console.error);
