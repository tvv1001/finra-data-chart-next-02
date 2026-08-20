import Redis from 'ioredis';

const redis = new Redis();

async function updateSecBrokers(firmId) {
    console.log(`Fixing keys for firm ${firmId}...`);
    const url = `https://api.adviserinfo.sec.gov/search/individual?firm=${firmId}&includePrevious=true&wt=json`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    
    const hits = data?.hits?.hits || [];
    const connected = new Set();
    const previous = new Set();
    
    for (const hit of hits) {
        const src = hit._source || {};
        const crd = String(src.ind_source_id || src.ind_crd || src.individualId || src.id);
        if (!crd) continue;
        
        // Use ind_ia_current_employments
        const currentIA = src.ind_ia_current_employments || [];
        if (currentIA.some(e => String(e.firmId || e.firm_id) === String(firmId))) {
            connected.add(crd);
        }
        
        // Use ind_previous_employments
        const previousIA = src.ind_previous_employments || [];
        if (previousIA.some(e => String(e.firmId || e.firm_id) === String(firmId))) {
            previous.add(crd);
        }
    }
    
    const connectedArray = Array.from(connected);
    const previousArray = Array.from(previous);
    
    console.log(`Setting sec:firm:${firmId}_brokers:connected to ${connectedArray.length} items`);
    await redis.set(`sec:firm:${firmId}_brokers:connected`, JSON.stringify(connectedArray));
    
    console.log(`Setting sec:firm:${firmId}_brokers:previous to ${previousArray.length} items`);
    await redis.set(`sec:firm:${firmId}_brokers:previous`, JSON.stringify(previousArray));
}

async function run() {
    await updateSecBrokers('10028');
    redis.disconnect();
}
run().catch(console.error);
