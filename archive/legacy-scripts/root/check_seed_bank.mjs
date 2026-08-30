import Redis from 'ioredis';
const redis = new Redis({ db: 0 });

async function run() {
    const raw = await redis.get('dashboard:seed-bank');
    if (!raw) {
        console.log("No dashboard:seed-bank key found.");
    } else {
        const data = JSON.parse(raw);
        console.log(`Seed bank found! Structure:`, Object.keys(data));
        console.log(`Total individuals:`, Object.keys(data.nameByNumber?.individual || {}).length);
        console.log(`Total firms:`, Object.keys(data.nameByNumber?.firm || {}).length);
    }
    redis.disconnect();
}
run().catch(console.error);
