import Redis from 'ioredis';

const redis = new Redis();

async function updateSecBrokers(firmId) {
    const url = `https://api.adviserinfo.sec.gov/search/individual?firm=${firmId}&includePrevious=true&wt=json`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return;
    const data = await res.json();
    
    const hits = data?.hits?.hits || [];
    const connected = new Set();
    const previous = new Set();
    
    for (const hit of hits) {
        const src = hit._source || {};
        const crd = String(src.ind_source_id || src.ind_crd || src.individualId || src.id);
        if (!crd) continue;
        
        const currentIA = [
            ...(hit.inner_hits?.ind_ia_current_employments?.hits?.hits?.map((h) => h._source) || []),
            ...(Array.isArray(src.ind_ia_current_employments) ? src.ind_ia_current_employments : [])
        ];
        if (currentIA.some(e => String(e.firmId || e.firm_id) === String(firmId))) {
            connected.add(crd);
        }
        
        const previousIA = [
            ...(hit.inner_hits?.ind_previous_employments?.hits?.hits?.map((h) => h._source) || []),
            ...(Array.isArray(src.ind_previous_employments) ? src.ind_previous_employments : [])
        ];
        if (previousIA.some(e => String(e.firmId || e.firm_id) === String(firmId))) {
            previous.add(crd);
        }
    }
    
    const connectedArray = Array.from(connected);
    const previousArray = Array.from(previous);
    
    if (connectedArray.length > 0) {
        await redis.set(`sec:firm:${firmId}_brokers:connected`, JSON.stringify(connectedArray));
    } else {
        await redis.del(`sec:firm:${firmId}_brokers:connected`);
    }
    
    if (previousArray.length > 0) {
        await redis.set(`sec:firm:${firmId}_brokers:previous`, JSON.stringify(previousArray));
    } else {
        await redis.del(`sec:firm:${firmId}_brokers:previous`);
    }
}

async function run() {
    const keys = await redis.keys('sec:firm:*_brokers:previous');
    for (const key of keys) {
        const firmId = key.split(':')[2].split('_')[0];
        console.log(`Updating ${firmId}...`);
        await updateSecBrokers(firmId);
    }
    console.log("Done.");
    redis.disconnect();
}
run().catch(console.error);
