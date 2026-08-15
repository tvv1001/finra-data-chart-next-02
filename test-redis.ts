import { getRecordFromRedis } from './src/lib/graphStore';
async function run() {
    const data = await getRecordFromRedis('firm', '13051');
    console.log("Keys in Redis data:", data ? Object.keys(data) : 'null');
    if (data && data.finraBrokerCheck) {
        console.log("Keys in finraBrokerCheck:", Object.keys(data.finraBrokerCheck));
    }
}
run();
