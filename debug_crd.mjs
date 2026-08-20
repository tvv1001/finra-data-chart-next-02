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

const getName = (src) => {
    if (!src) return null;
    if (src.basicInformation) {
        if (src.basicInformation.firmName) return src.basicInformation.firmName;
        if (src.basicInformation.name) return src.basicInformation.name;
    }
    if (src.firmName) return src.firmName;
    if (src.name) return src.name;
    if (src.individualName) return src.individualName;
    if (src.ind_firstname && src.ind_lastname) return `${src.ind_firstname} ${src.ind_lastname}`;
    if (src.firm_name) return src.firm_name;
    return null;
};

async function run() {
    const keys = await redis.keys('*');
    const indKeys = keys.filter(k => /^finra:individual:\d+$/.test(k));
    
    let fails = 0;
    for (const key of indKeys) {
        try {
            const raw = await redis.get(key);
            const uncompressed = decompressPayload(raw);
            let obj;
            try { obj = JSON.parse(uncompressed); } catch(e) { fails++; continue; }
            
            let name = null;
            let src = obj;
            
            if (obj.hits?.hits?.[0]?._source) {
                src = obj.hits.hits[0]._source;
                if (typeof src.content === 'string') {
                    try { src = JSON.parse(src.content); } catch(e) {}
                }
            } else if (obj._source) {
                src = obj._source;
            } else if (typeof obj.content === 'string') {
                try { src = JSON.parse(obj.content); } catch(e) {}
            }
            
            name = getName(src);
            if (!name) name = getName(obj);
            
            if (!name) {
                console.log(`Failed to get name for ${key}. Payload preview: ${uncompressed.substring(0, 200)}`);
                fails++;
                if (fails > 5) break;
            }
        } catch(e) {}
    }
    console.log(`Fails early stop: ${fails}`);
    redis.disconnect();
}
run().catch(console.error);
