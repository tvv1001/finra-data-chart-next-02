import Redis from 'ioredis';
import zlib from 'zlib';

const redis = new Redis();

function decompressPayload(raw) {
    if (!raw) return null;
    if (typeof raw !== 'string') return raw;
    if (raw.startsWith('br:')) {
        const b64 = raw.substring(3);
        const buf = Buffer.from(b64, 'base64');
        return zlib.brotliDecompressSync(buf).toString('utf-8');
    }
    return raw;
}

async function run() {
    const keys = await redis.keys('sec:firm:*');
    const firmKeys = keys.filter(k => /sec:firm:\d+$/.test(k)).slice(0, 5);
    
    for (const key of firmKeys) {
        const raw = await redis.get(key);
        const uncompressed = decompressPayload(raw);
        console.log(`\nKey: ${key}`);
        console.log(`Type of uncompressed: ${typeof uncompressed}`);
        console.log(`Preview: ${uncompressed ? uncompressed.substring(0, 150) : null}`);
    }
    
    redis.disconnect();
}
run().catch(console.error);
