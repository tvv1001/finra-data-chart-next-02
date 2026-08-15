const Redis = require('ioredis');
const zlib = require('zlib');
const fs = require('fs');

const redis = new Redis('redis://127.0.0.1:6379');

function isPlainObject(value) {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getEmbeddedContentObject(source, contentKeys = ['content', 'iacontent']) {
	if (!isPlainObject(source)) return null;
	for (const key of contentKeys) {
		const raw = source[key];
		if (raw == null) continue;
		if (isPlainObject(raw)) return raw;
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				if (isPlainObject(parsed)) return parsed;
			} catch {
				return null;
			}
		}
	}
	return null;
}

function decompressPayload(value) {
	if (typeof value === 'string' && value.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(value.slice(3), 'base64')).toString('utf-8');
		} catch {
			return value;
		}
	}
	return value;
}

function parseRedisValue(raw) {
	if (raw == null) return null;
	const isBuf = typeof Buffer !== 'undefined' && Buffer.isBuffer(raw);
	if (typeof raw === 'string' || isBuf) {
		const strRaw = isBuf ? raw.toString('utf8') : raw;
		const decompressed = decompressPayload(strRaw);
		try { return JSON.parse(decompressed); } catch { return null; }
	}
	return raw;
}

async function run() {
    console.log("Scanning Redis for orphan (non-live) CRDs...");
    let cursor = '0';
    let orphanIndividuals = [];
    let orphanFirms = [];
    let uniqueCRDs = new Set();
    
    // Check local redis
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'finra:*', 'COUNT', 1000);
        cursor = nextCursor;
        
        for (const key of keys) {
            if (!key.startsWith('finra:individual:') && !key.startsWith('finra:firm:')) continue;
            
            const raw = await redis.get(key);
            if (!raw) continue;
            
            const parsed = parseRedisValue(raw);
            if (!parsed) continue;
            
            const isFirm = key.startsWith('finra:firm:');
            const crdMatch = key.match(/:(\d+)$/);
            if (!crdMatch) continue;
            const crd = crdMatch[1];
            
            let isOrphan = false;
            
            if (parsed.orphan) {
                isOrphan = true;
            } else if (parsed.hits && parsed.hits.hits && parsed.hits.hits.length > 0) {
                const source = parsed.hits.hits[0]._source || {};
                const embedded = getEmbeddedContentObject(source, ['content', 'iacontent']);
                if (!embedded && !isPlainObject(source.basicInformation)) {
                    isOrphan = true;
                } else if (embedded && typeof embedded === 'object') {
                    // Check if it's explicitly NotInScope without any registrations
                    const bcScope = String(embedded.bcScope || '').trim().toLowerCase();
                    const iaScope = String(embedded.iaScope || '').trim().toLowerCase();
                    if (bcScope === 'notinscope' && iaScope === 'notinscope') {
                        isOrphan = true;
                    }
                }
            } else {
                isOrphan = true;
            }
            
            uniqueCRDs.add(crd);
            
            if (isOrphan) {
                if (isFirm) {
                    orphanFirms.push(crd);
                } else {
                    orphanIndividuals.push(crd);
                }
            }
        }
        process.stdout.write(`\rScanned. Found ${orphanIndividuals.length} person orphans, ${orphanFirms.length} firm orphans. Unique CRDs seen: ${uniqueCRDs.size}`);
    } while (cursor !== '0');
    
    console.log(`\n\nFinal Report:`);
    console.log(`Total Unique CRDs: ${uniqueCRDs.size}`);
    console.log(`Total Orphan (Non-Live) Person CRDs: ${orphanIndividuals.length}`);
    console.log(`Total Orphan (Non-Live) Firm CRDs: ${orphanFirms.length}`);
    
    fs.writeFileSync('orphan_crds.json', JSON.stringify({
        orphanIndividuals,
        orphanFirms,
        uniqueCRDsCount: uniqueCRDs.size
    }, null, 2));
    console.log(`Saved to orphan_crds.json`);
}

run().catch(console.error);
