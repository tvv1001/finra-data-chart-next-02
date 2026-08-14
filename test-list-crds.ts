import { config } from 'dotenv';
config({ path: '.env.local' });
import { getRedisClientInstance } from './src/lib/redisClient';

async function test() {
  const redis = getRedisClientInstance({ url: '', token: '' });
  const keys = await redis.keys('finra:*');
  console.log('finra keys length:', keys.length);
}
test().catch(console.error);
