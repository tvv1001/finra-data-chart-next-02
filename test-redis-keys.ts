import { getRedisClient } from './src/lib/redisClient';
async function run() {
    const redis = getRedisClient();
    const ind = await redis.zrange('dashboard:highest-crds:individual', 0, 19, { rev: true });
    const firm = await redis.zrange('dashboard:highest-crds:firm', 0, 19, { rev: true });
    console.log("ind:", ind);
    console.log("firm:", firm);
}
run();
