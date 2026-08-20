import Redis from 'ioredis';
const redis = new Redis();
async function run() {
    const keys = await redis.keys('sec:firm:*');
    // filter out summaryHtml and brokers keys just to get a raw firm key first
    const firmKeys = keys.filter(k => /sec:firm:\d+$/.test(k));
    if (firmKeys.length === 0) {
        console.log("No firm keys found.");
        return;
    }
    const sampleKey = firmKeys[0];
    const data = await redis.get(sampleKey);
    console.log(`Key: ${sampleKey}`);
    console.log(`Content (first 1000 chars): ${data ? data.substring(0, 1000) : 'null'}`);
    
    // Also peek at a brokers key
    const connectedKey = `${sampleKey}_brokers:connected`;
    const previousKey = `${sampleKey}_brokers:previous`;
    
    const connectedData = await redis.get(connectedKey);
    const previousData = await redis.get(previousKey);
    
    console.log(`\nKey: ${connectedKey}`);
    console.log(`Content: ${connectedData || 'null'}`);
    
    console.log(`\nKey: ${previousKey}`);
    console.log(`Content: ${previousData || 'null'}`);
    
    redis.disconnect();
}
run().catch(console.error);
