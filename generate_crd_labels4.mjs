import Redis from 'ioredis';
import fs from 'fs/promises';
import path from 'path';
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
        if (src.basicInformation.firstName && src.basicInformation.lastName) {
            return [src.basicInformation.firstName, src.basicInformation.middleName, src.basicInformation.lastName].filter(Boolean).join(' ');
        }
    }
    if (src.firmName) return src.firmName;
    if (src.name) return src.name;
    if (src.individualName) return src.individualName;
    if (src.ind_firstname && src.ind_lastname) return `${src.ind_firstname} ${src.ind_lastname}`;
    if (src.firm_name) return src.firm_name;
    
    // Check if firstName / lastName is at the root level
    if (src.firstName && src.lastName) {
        return [src.firstName, src.middleName, src.lastName].filter(Boolean).join(' ');
    }
    return null;
};

async function run() {
    console.log("Fetching all relevant keys...");
    const keys = await redis.keys('*');
    const firmKeys = keys.filter(k => /^(finra|sec):firm:\d+$/.test(k));
    const indKeys = keys.filter(k => /^(finra|sec):individual:\d+$/.test(k));
    const allKeys = [...firmKeys, ...indKeys];
    
    console.log(`Found ${firmKeys.length} firm keys and ${indKeys.length} individual keys.`);
    const resultsMap = new Map();
    let processed = 0;
    
    for (const key of allKeys) {
        processed++;
        try {
            const raw = await redis.get(key);
            if (!raw) continue;
            const uncompressed = decompressPayload(raw);
            let obj;
            try { obj = JSON.parse(uncompressed); } catch(e) { continue; }
            
            const isFirm = key.includes(':firm:');
            const crd = key.split(':').pop();
            
            let name = null;
            let src = obj;
            
            if (obj.hits?.hits?.[0]?._source) {
                src = obj.hits.hits[0]._source;
                // If it's a string payload inside 'content' or 'iacontent'
                if (typeof src.content === 'string') {
                    try { src = JSON.parse(src.content); } catch(e) {}
                } else if (typeof src.iacontent === 'string') {
                    try { src = JSON.parse(src.iacontent); } catch(e) {}
                }
            } else if (obj._source) {
                src = obj._source;
            } else if (obj.secInvestmentAdvisor) {
                src = obj.secInvestmentAdvisor;
            } else if (typeof obj.content === 'string') {
                try { src = JSON.parse(obj.content); } catch(e) {}
            } else if (typeof obj.iacontent === 'string') {
                try { src = JSON.parse(obj.iacontent); } catch(e) {}
            }
            
            name = getName(src);
            if (!name) name = getName(obj);
            
            if (crd && name) {
                name = String(name).replace(/\s+/g, ' ').trim();
                resultsMap.set(crd, { crd, label: name, type: isFirm ? 'firm' : 'individual' });
            } else {
                // To check if there are still any gaps!
                // console.log("Missing name for", key);
            }
        } catch (e) {}
    }
    
    const outArr = Array.from(resultsMap.values());
    console.log(`Extracted ${outArr.length} unique CRDs.`);
    
    const outPath = path.join(process.cwd(), 'public', 'search-indexes', 'node-search-cache.json');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(outArr));
    
    console.log(`Saved to ${outPath}`);
    redis.disconnect();
}
run().catch(console.error);
