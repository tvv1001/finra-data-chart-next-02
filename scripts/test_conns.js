const fs = require('fs');
const Redis = require('ioredis');
const zlib = require('zlib');
const redis = new Redis('redis://127.0.0.1:6379');

async function test() {
    let raw = await redis.get('finra:firm:149777');
    if(raw && raw.startsWith('br:')) {
        raw = zlib.brotliDecompressSync(Buffer.from(raw.slice(3), 'base64')).toString('utf8');
    }
    const data = JSON.parse(raw);
    const conns = data.content?.connections?.firmConnections?.affiliatedFirms || [];
    console.log(JSON.stringify(conns, null, 2));
    process.exit(0);
}
test();
