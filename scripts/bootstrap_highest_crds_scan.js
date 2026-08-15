const { Redis } = require('@upstash/redis');

async function main() {
    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
    });

    console.log('Scanning individuals...');
    let cursor = '0';
    let individualIds = [];
    do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: 'finra:individual:*', count: 1000 });
        for (const key of keys) {
            const id = key.split(':').pop();
            individualIds.push(Number(id));
        }
        cursor = nextCursor === '0' || !nextCursor ? '0' : String(nextCursor);
    } while (cursor !== '0');

    individualIds.sort((a, b) => b - a);
    const topIndividuals = individualIds.slice(0, 50);
    console.log('Top Individuals:', topIndividuals);

    console.log('Scanning firms...');
    cursor = '0';
    let firmIds = [];
    do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: 'finra:firm:*', count: 1000 });
        for (const key of keys) {
            const id = key.split(':').pop();
            firmIds.push(Number(id));
        }
        cursor = nextCursor === '0' || !nextCursor ? '0' : String(nextCursor);
    } while (cursor !== '0');

    firmIds.sort((a, b) => b - a);
    const topFirms = firmIds.slice(0, 50);
    console.log('Top Firms:', topFirms);

    for (const id of topIndividuals) {
        await redis.zadd('dashboard:highest-crds:individual', { score: id, member: String(id) });
    }
    for (const id of topFirms) {
        await redis.zadd('dashboard:highest-crds:firm', { score: id, member: String(id) });
    }
    
    await redis.del('dashboard:new-crds-cache');
    console.log('Successfully bootstrapped highest CRDs to Upstash.');
}

main().catch(console.error);
