import { getRedisClient } from './src/lib/redisCache';

async function run() {
  const redis = getRedisClient();
  if (!redis) return;
  
  let malformedCrds = [];
  const keysStrInd = await redis.keys('finra:individual:*');
  const keysStrFirm = await redis.keys('finra:firm:*');
  const keys = [...(Array.isArray(keysStrInd) ? keysStrInd : []), ...(Array.isArray(keysStrFirm) ? keysStrFirm : [])];
  console.log(`Found ${keys.length} keys`);
  
  let checked = 0;
  for (const rawKey of keys) {
      const key = String(rawKey);
      const entity = key.includes('individual') ? 'individual' : 'firm';
      const crd = key.split(':').pop();
      try {
        const finraStr = await redis.get(key);
        if (!finraStr) continue;
        const finraPayload = typeof finraStr === 'string' ? JSON.parse(finraStr) : finraStr;
        const basic = finraPayload.basicInformation || {};
        
        let bcScope = basic.bcScope || finraPayload.bcScope || basic.brokerCheckScope || '';
        let iaScope = basic.iaScope || finraPayload.iaScope || basic.secScope || '';
        
        // If it's a firm, we might need to check if we have SEC data
        const secStr = await redis.get(`sec:${entity}:${crd}`);
        const hasSecData = !!secStr;
        
        if (entity === 'firm') {
            if (bcScope.toLowerCase() === 'inactive' && hasSecData) {
               malformedCrds.push({ crd, entity });
               continue;
            }
        } else {
            const bcLow = bcScope.toLowerCase();
            const iaLow = iaScope.toLowerCase();
            
            const bcActive = bcLow === 'active';
            const iaActive = iaLow === 'active' || hasSecData;
            
            const bcInactive = bcLow.includes('inactive') || bcLow.includes('notinscope');
            const iaInactive = iaLow.includes('inactive') || iaLow.includes('notinscope');
            
            if ((bcInactive && iaActive) || (bcActive && iaInactive)) {
               malformedCrds.push({ crd, entity });
            }
        }
      } catch (err) {
      }
      checked++;
      if (checked % 5000 === 0) console.log(`Checked ${checked}...`);
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
