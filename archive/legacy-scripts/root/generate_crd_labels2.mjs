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
    // Might be base64 gzip or just base64 json in old format, but lets try parse directly if not br:
    // Some are json directly.
    return raw;
}

async function run() {
    console.log("Fetching all relevant keys...");
    const keys = await redis.keys('*');
    
    // Filter firm and individual keys
    const firmKeys = keys.filter(k => /^(finra|sec):firm:\d+$/.test(k));
    const indKeys = keys.filter(k => /^(finra|sec):individual:\d+$/.test(k));
    
    console.log(`Found ${firmKeys.length} firm keys and ${indKeys.length} individual keys.`);
    
    const resultsMap = new Map();
    
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
    
    const allKeys = [...firmKeys, ...indKeys];
    let processed = 0;
    
    for (const key of allKeys) {
        processed++;
        if (processed % 1000 === 0) console.log(`Processed ${processed} / ${allKeys.length}`);
        
        try {
            const raw = await redis.get(key);
            if (!raw) continue;
            
            const uncompressed = decompressPayload(raw);
            let obj;
            try {
                obj = JSON.parse(uncompressed);
            } catch(e) {
                // If it fails to parse as JSON, might be another format, just skip
                continue;
            }
            
            const isFirm = key.includes(':firm:');
            const crd = key.split(':').pop();
            
            let name = null;
            
            // Check possible paths
            if (obj.hits?.hits?.[0]?._source) {
                name = getName(obj.hits.hits[0]._source);
            }
            if (!name && obj._source) {
                name = getName(obj._source);
            }
            if (!name && obj.secInvestmentAdvisor) {
                name = getName(obj.secInvestmentAdvisor);
            }
            if (!name) {
                name = getName(obj);
            }
            
            if (crd && name) {
                // Remove extra spaces
                name = String(name).replace(/\s+/g, ' ').trim();
                resultsMap.set(crd, { crd, label: name, type: isFirm ? 'firm' : 'individual' });
            }
        } catch (e) {
            // ignore
        }
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
