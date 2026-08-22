import { Redis } from '@upstash/redis';
import fs from 'fs';

const envFile = fs.readFileSync('.env.local', 'utf-8');
const extract = (key) => {
    const match = envFile.match(new RegExp(`${key}="?([^"\\n]+)`));
    return match ? match[1] : null;
};

const dbs = [
    { name: 'DB1 (awake-dodo)', url: extract('UPSTASH_REDIS_REST_URL'), token: extract('UPSTASH_REDIS_REST_TOKEN') },
    { name: 'DB2 (relieved-tick / MIRROR / FINRASEC2)', url: extract('UPSTASH_REDIS_REST_URL_MIRROR'), token: extract('UPSTASH_REDIS_REST_TOKEN_MIRROR') }
];

async function run() {
    for (const db of dbs) {
        if (!db.url || !db.token) continue;
        console.log(`\nTesting ${db.name}...`);
        try {
            const client = new Redis({ url: db.url, token: db.token });
            
            const startPing = Date.now();
            await client.dbsize();
            const latency = Date.now() - startPing;
            
            const size = await client.dbsize();
            console.log(`✅ Connection Successful!`);
            console.log(`📊 DB Size: ${size.toLocaleString()} keys`);
            console.log(`⚡ Ping Latency: ${latency}ms`);
            
        } catch (err) {
            console.error(`❌ Failed to connect:`, err.message);
        }
    }
}
run();
