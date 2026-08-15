const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

async function main() {
    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
    });

    const crdLogPath = path.join(process.cwd(), 'data', 'national', 'crd-log.json');
    let crdLog;
    try {
        crdLog = JSON.parse(fs.readFileSync(crdLogPath, 'utf8'));
    } catch (e) {
        console.error('Failed to read crd-log.json', e);
        return;
    }

    const topIndividuals = crdLog.individuals
        .map(i => Number(i.id))
        .filter(id => !isNaN(id))
        .sort((a, b) => b - a)
        .slice(0, 50);

    const topFirms = crdLog.firms
        .map(i => Number(i.id))
        .filter(id => !isNaN(id))
        .sort((a, b) => b - a)
        .slice(0, 50);

    console.log('Top Individuals:', topIndividuals);
    console.log('Top Firms:', topFirms);

    for (const id of topIndividuals) {
        await redis.zadd('dashboard:highest-crds:individual', { score: id, member: String(id) });
    }
    for (const id of topFirms) {
        await redis.zadd('dashboard:highest-crds:firm', { score: id, member: String(id) });
    }
    
    // Clear the new-crds-cache so it rebuilds on next load
    await redis.del('dashboard:new-crds-cache');

    console.log('Successfully bootstrapped highest CRDs to Upstash.');
}

main().catch(console.error);
