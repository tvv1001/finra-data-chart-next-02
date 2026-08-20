import Redis from 'ioredis';
const redis = new Redis();

async function run() {
    console.log("Fetching all broker keys...");
    const connectedKeys = await redis.keys('sec:firm:*_brokers:connected');
    const previousKeys = await redis.keys('sec:firm:*_brokers:previous');
    
    let deleted = 0;
    
    for (const key of [...connectedKeys, ...previousKeys]) {
        const val = await redis.get(key);
        if (val === '[]') {
            await redis.del(key);
            deleted++;
        }
    }
    
    console.log(`Deleted ${deleted} empty keys.`);
    redis.disconnect();
}
run().catch(console.error);
