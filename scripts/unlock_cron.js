import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();
await redis.del("cron:external-validity:lock");
console.log("Unlocked!");
