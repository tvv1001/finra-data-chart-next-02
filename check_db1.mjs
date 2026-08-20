import Redis from 'ioredis';
const redis = new Redis({ db: 1 });
async function run() {
    const keys = await redis.keys('*');
    console.log(`DB 1 has ${keys.length} keys.`);
    redis.disconnect();
}
run().catch(console.error);
