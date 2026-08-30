import Redis from 'ioredis';
const redis = new Redis({ db: 0 });

async function run() {
    try {
        const dbsize = await redis.dbsize();
        const info = await redis.info('memory');
        const usedMemoryHuman = info.split('\n').find(line => line.startsWith('used_memory_human:')).split(':')[1].trim();
        
        console.log(`Local Redis DB Size (Keys): ${dbsize.toLocaleString()}`);
        console.log(`Local Redis Used Memory: ${usedMemoryHuman}`);
    } catch (err) {
        console.error("Error:", err.message);
    } finally {
        redis.disconnect();
    }
}
run();
