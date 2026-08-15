import { getRedisClient } from './src/lib/redisCache';

async function run() {
  const redis = getRedisClient();
  if (!redis) return;
  
  let malformedCrds = [];
  const keysStr = await redis.keys('finra:firm:*');
  const keys = Array.isArray(keysStr) ? keysStr : [];
  console.log(`Found ${keys.length} keys`);
  
  for (const rawKey of keys) {
      const key = String(rawKey);
      const crd = key.split(':').pop();
      try {
        const payloadStr = await redis.get(key);
        if (!payloadStr) continue;
        const payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
        const basic = payload.basicInformation || {};
        const bcScope = basic.bcScope || payload.bcScope || '';
        const iaScope = basic.iaScope || payload.iaScope || '';
        
        const bcActive = bcScope.toLowerCase() === 'active';
        const iaActive = iaScope.toLowerCase() === 'active';
        const bcInactive = bcScope.toLowerCase().includes('inactive') || bcScope.toLowerCase().includes('not in scope') || bcScope.toLowerCase() === 'notinsccope';
        const iaInactive = iaScope.toLowerCase().includes('inactive') || iaScope.toLowerCase().includes('not in scope') || iaScope.toLowerCase() === 'notinsccope';
        
        if (bcScope && iaScope) {
           if ((bcActive && iaInactive) || (bcInactive && iaActive)) {
               malformedCrds.push(crd);
           }
        }
      } catch (err) {
      }
  }
  
  console.log(`Found ${malformedCrds.length} malformed firm CRDs`);
  for (let i = 0; i < malformedCrds.length; i++) {
     const crd = malformedCrds[i];
     console.log(`Fixing firm ${crd}...`);
     await fetch('http://localhost:4444/api/dashboard/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 
           action: 'fetch-crds', 
           targets: [{ source: 'finra', type: 'firm', crd: String(crd) }] 
        })
     });
  }
}
run().catch(console.error);
