import Redis from 'ioredis';
const redis = new Redis({ db: 1 });
async function run() {
    const keys = await redis.keys('*');
    console.log(keys.slice(0, 10));
    redis.disconnect();
}
run().catch(console.error);
