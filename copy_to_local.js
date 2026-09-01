const axios = require('axios');
const Redis = require('ioredis');

async function copyToLocal(crd) {
    const fetchUrl = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true`;
    console.log('Fetching', fetchUrl);
    const res = await axios.get(fetchUrl);
    const redis = new Redis('redis://127.0.0.1:6379');
    await redis.set(`finra:individual:${crd}`, JSON.stringify(res.data));
    console.log(`Copied ${crd} to local redis`);
    process.exit(0);
}

copyToLocal(process.argv[2]).catch(console.error);
