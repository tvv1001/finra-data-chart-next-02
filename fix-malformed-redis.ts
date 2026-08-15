import { getRedisClient } from './src/lib/redisCache';

async function run() {
  const redis = getRedisClient();
  if (!redis) return;
  
  let malformedCrds = [];
  const keysStrInd = await redis.keys('finra:individual:*');
  const keysStrFirm = await redis.keys('finra:firm:*');
  const keys = [...(Array.isArray(keysStrInd) ? keysStrInd : []), ...(Array.isArray(keysStrFirm) ? keysStrFirm : [])];
  console.log(`Found ${keys.length} keys`);
  
  for (const rawKey of keys) {
      const key = String(rawKey);
      const entity = key.includes('individual') ? 'individual' : 'firm';
      const crd = key.split(':').pop();
      try {
        const payloadStr = await redis.get(key);
        if (!payloadStr) continue;
        const payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
        const basic = payload.basicInformation || {};
        const bcScope = basic.bcScope || payload.bcScope || '';
        const iaScope = basic.iaScope || payload.iaScope || '';
        
        const bcLow = bcScope.toLowerCase();
        const iaLow = iaScope.toLowerCase();
        
        const bcActive = bcLow === 'active';
        const iaActive = iaLow === 'active';
        const bcInactive = bcLow.includes('inactive') || bcLow.includes('notinscope') || bcLow.includes('not in scope');
        const iaInactive = iaLow.includes('inactive') || iaLow.includes('notinscope') || iaLow.includes('not in scope');
        
        if (bcScope && iaScope) {
           if ((bcActive && iaInactive) || (bcInactive && iaActive)) {
               malformedCrds.push({ crd, entity });
           }
        }
      } catch (err) {
      }
  }
  
  console.log(`Found ${malformedCrds.length} malformed CRDs`);
  for (let i = 0; i < malformedCrds.length; i++) {
     const item = malformedCrds[i];
     console.log(`Fixing ${item.entity} ${item.crd}...`);
     await fetch('http://localhost:4444/api/dashboard/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 
           action: 'fetch-crds', 
           targets: [{ source: 'finra', type: item.entity, crd: String(item.crd) }] 
        })
     });
  }
}
run().catch(console.error);
