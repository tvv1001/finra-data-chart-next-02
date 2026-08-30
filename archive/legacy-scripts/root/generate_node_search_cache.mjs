import Redis from 'ioredis';
import fs from 'fs';
const redis = new Redis();

async function run() {
    console.log("Fetching keys...");
    const keys = await redis.keys('*');
    const results = [];
    
    // We only care about main firm and individual keys
    const firmKeys = keys.filter(k => /^(finra|sec):firm:\d+$/.test(k));
    const indKeys = keys.filter(k => /^(finra|sec):individual:\d+$/.test(k));
    
    console.log(`Found ${firmKeys.length} firm keys and ${indKeys.length} individual keys.`);
    
    const allKeys = [...firmKeys, ...indKeys];
    let count = 0;
    
    for (const key of allKeys) {
        try {
            const raw = await redis.get(key);
            if (!raw) continue;
            // Handle decompressed or compressed
            let payload = raw;
            if (raw.startsWith('br:')) {
                // we'll just skip br: for this quick script if we don't have brotli setup, 
                // but actually we can just use the search-indexes in public/search-indexes/!
            }
        } catch (e) {}
    }
    
    redis.disconnect();
}
run().catch(console.error);
