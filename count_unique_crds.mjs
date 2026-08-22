import Redis from 'ioredis';
const redis = new Redis({ db: 0 });

async function run() {
    try {
        console.log("Fetching all keys from local Redis...");
        const keys = await redis.keys('*');
        
        const individualCrds = new Set();
        const firmCrds = new Set();
        let otherKeys = 0;

        for (const key of keys) {
            const match = key.match(/^(finra|sec):(individual|firm):(\d+)$/);
            if (match) {
                const type = match[2];
                const crd = match[3];
                if (type === 'individual') {
                    individualCrds.add(crd);
                } else if (type === 'firm') {
                    firmCrds.add(crd);
                }
            } else {
                otherKeys++;
            }
        }
        
        console.log(`\n--- Unique CRDs in Local Redis ---`);
        console.log(`Individuals: ${individualCrds.size.toLocaleString()}`);
        console.log(`Firms: ${firmCrds.size.toLocaleString()}`);
        console.log(`Total Unique CRDs: ${(individualCrds.size + firmCrds.size).toLocaleString()}`);
        console.log(`(Other Non-CRD Keys: ${otherKeys.toLocaleString()})`);
        
    } catch (err) {
        console.error("Error:", err.message);
    } finally {
        redis.disconnect();
    }
}
run();
