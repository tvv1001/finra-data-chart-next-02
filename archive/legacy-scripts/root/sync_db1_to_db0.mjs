import Redis from 'ioredis';

const redis0 = new Redis({ db: 0 });
const redis1 = new Redis({ db: 1 });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
    console.log("Fetching keys from DB 1...");
    const keys1 = await redis1.keys('*');
    const detailKeys = keys1.filter(k => /^(finra|sec):(individual|firm):\d+$/.test(k));
    
    console.log(`Found ${detailKeys.length} detail keys in DB 1.`);
    
    let added = 0;
    let checked = 0;
    
    for (const key of detailKeys) {
        checked++;
        const exists = await redis0.exists(key);
        if (!exists) {
            console.log(`Key ${key} missing in DB 0. Fetching from DB 1...`);
            const val = await redis1.get(key);
            
            // To check external API, we parse the key
            const [source, type, crd] = key.split(':');
            
            // Check external API (rate limited, so we add a delay)
            let isCorrect = false;
            try {
                let url;
                if (source === 'finra' && type === 'individual') {
                    url = `https://api.brokercheck.finra.org/search/individual/${crd}?hl=true&includePrevious=true&wt=json`;
                } else if (source === 'sec' && type === 'individual') {
                    url = `https://api.adviserinfo.sec.gov/search/individual/${crd}?hl=true&includePrevious=true&wt=json`;
                } else if (source === 'finra' && type === 'firm') {
                    url = `https://api.brokercheck.finra.org/search/firm/${crd}?wt=json`;
                } else if (source === 'sec' && type === 'firm') {
                    url = `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`;
                }
                
                if (url) {
                    console.log(`Validating against external API: ${url}`);
                    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if (res.ok) {
                        const freshData = await res.json();
                        // Overwrite with fresh data if valid
                        await redis0.set(key, JSON.stringify(freshData));
                        isCorrect = true;
                    }
                }
            } catch (e) {
                console.error(`Failed to validate ${key}:`, e.message);
            }
            
            if (!isCorrect && val) {
                // Fallback to DB 1 data
                await redis0.set(key, val);
            }
            
            added++;
            
            // Respect rate limits!
            await sleep(1000); 
        }
    }
    
    console.log(`Done. Checked ${checked} keys, added/updated ${added} missing keys to DB 0.`);
    redis0.disconnect();
    redis1.disconnect();
}
run().catch(console.error);
