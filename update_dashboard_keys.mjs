import Redis from 'ioredis';
const redis = new Redis({ db: 0 });

async function run() {
    const keys = await redis.keys('*');
    const firmKeys = keys.filter(k => /^(finra|sec):firm:\d+$/.test(k));
    const indKeys = keys.filter(k => /^(finra|sec):individual:\d+$/.test(k));
    
    const uniqueFirms = new Set();
    const uniqueInds = new Set();
    
    // Sort keys or extract them for latest
    for (const k of firmKeys) {
        uniqueFirms.add(k.split(':').pop());
    }
    
    for (const k of indKeys) {
        uniqueInds.add(k.split(':').pop());
    }
    
    const totalUnique = new Set([...uniqueFirms, ...uniqueInds]).size;
    
    console.log(`Setting dashboard:cached-crd-count to ${totalUnique}`);
    await redis.set('dashboard:cached-crd-count', totalUnique);
    
    // The user said "and here's the list of 20 new CRDs: Key: dashboard:highest-crds:firm Key: dashboard:highest-crds:individual"
    // They probably want me to populate the sorted sets!
    
    // For firms, let's take all unique firms, sort them descending numerically by CRD, and take top 20
    const sortedFirms = Array.from(uniqueFirms).map(Number).sort((a,b) => b - a).slice(0, 20);
    console.log(`Top 20 firms:`, sortedFirms);
    for (const crd of sortedFirms) {
        await redis.zadd('dashboard:highest-crds:firm', crd, String(crd));
    }
    
    // For individuals
    const sortedInds = Array.from(uniqueInds).map(Number).sort((a,b) => b - a).slice(0, 20);
    console.log(`Top 20 individuals:`, sortedInds);
    for (const crd of sortedInds) {
        await redis.zadd('dashboard:highest-crds:individual', crd, String(crd));
    }
    
    redis.disconnect();
}
run().catch(console.error);
