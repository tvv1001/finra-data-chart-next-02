const fs = require('fs');

async function run() {
  const listRes = await fetch('http://localhost:4444/api/dashboard/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list-cache-cards', maxCards: 50000 })
  });
  const data = await listRes.json();
  const cards = data.cards || [];
  
  let malformedCrds = [];
  
  for (let i = 0; i < cards.length; i++) {
     const card = cards[i];
     if (card.sources.length < 2) continue; // Only care if it has both finra and sec sources
     
     // Fetch the detail to inspect both bcScope and iaScope
     const res = await fetch(`http://localhost:4444/api/finra/${card.entity}/${card.id}`);
     const detail = await res.json();
     
     if (!detail.merged) continue;
     const basic = detail.merged.basicInformation || {};
     
     const bcScope = basic.bcScope || detail.merged.bcScope || basic.brokerCheckScope || detail.merged.brokerCheckScope || detail.merged.bc_scope || '';
     const iaScope = basic.iaScope || detail.merged.iaScope || basic.secScope || detail.merged.secScope || detail.merged.ia_scope || '';
     
     if (!bcScope || !iaScope) continue;
     
     const bcActive = bcScope.toLowerCase() === 'active';
     const iaActive = iaScope.toLowerCase() === 'active';
     
     const bcInactive = bcScope.toLowerCase() === 'inactive';
     const iaInactive = iaScope.toLowerCase() === 'inactive';
     
     if ((bcActive && iaInactive) || (bcInactive && iaActive)) {
         malformedCrds.push(card);
     }
  }
  
  console.log(`Found ${malformedCrds.length} malformed CRDs`);
  
  for (let i = 0; i < malformedCrds.length; i++) {
     const card = malformedCrds[i];
     console.log(`Fixing ${card.entity} ${card.id}...`);
     await fetch('http://localhost:4444/api/dashboard/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 
           action: 'fetch-crds', 
           targets: [{ source: 'finra', type: card.entity, crd: card.id }] 
        })
     });
     console.log(`Done ${i+1}/${malformedCrds.length}`);
  }
}
run().catch(console.error);
