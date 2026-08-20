import Redis from 'ioredis';
import fs from 'fs/promises';
import path from 'path';

const redis = new Redis();

async function run() {
    console.log("Fetching all relevant keys...");
    const keys = await redis.keys('*');
    
    // Filter firm and individual keys (ignoring summaryHtml, snap, _brokers, etc.)
    const firmKeys = keys.filter(k => /^(finra|sec):firm:\d+$/.test(k));
    const indKeys = keys.filter(k => /^(finra|sec):individual:\d+$/.test(k));
    
    console.log(`Found ${firmKeys.length} firm keys and ${indKeys.length} individual keys.`);
    
    const resultsMap = new Map(); // crd -> { crd, label, type }
    
    // Helper to get name
    const getName = (src) => {
        if (!src) return null;
        if (src.basicInformation) {
            if (src.basicInformation.firmName) return src.basicInformation.firmName;
            if (src.basicInformation.name) return src.basicInformation.name;
        }
        if (src.firmName) return src.firmName;
        if (src.name) return src.name;
        if (src.individualName) return src.individualName;
        return null;
    };
    
    let processed = 0;
    
    const allKeys = [...firmKeys, ...indKeys];
    for (const key of allKeys) {
        processed++;
        if (processed % 1000 === 0) console.log(`Processed ${processed} / ${allKeys.length}`);
        
        try {
            const raw = await redis.get(key);
            if (!raw) continue;
            
            let obj;
            try {
                obj = JSON.parse(raw);
            } catch (e) {
                // If it fails, might be compressed 'br:' or similar, but the user is using local redis without compression for fetch_individuals script probably? 
                // Let's assume plain JSON for now, or fallback.
                continue;
            }
            
            const isFirm = key.includes(':firm:');
            const crd = key.split(':').pop();
            
            // For FINRA/SEC responses, it might be nested
            let src = obj;
            if (obj.hits?.hits?.[0]?._source) {
                src = obj.hits.hits[0]._source;
            } else if (obj._source) {
                src = obj._source;
            } else if (obj.secInvestmentAdvisor) {
                src = obj.secInvestmentAdvisor;
            }
            
            let name = getName(src);
            if (!name) name = getName(obj);
            
            if (crd && name) {
                resultsMap.set(crd, { crd, label: String(name).trim(), type: isFirm ? 'firm' : 'individual' });
            }
        } catch (e) {}
    }
    
    const outArr = Array.from(resultsMap.values());
    console.log(`Extracted ${outArr.length} CRDs.`);
    
    const outPath = path.join(process.cwd(), 'public', 'search-indexes', 'node-search-cache.json');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(outArr));
    
    console.log(`Saved to ${outPath}`);
    redis.disconnect();
}
run().catch(console.error);
