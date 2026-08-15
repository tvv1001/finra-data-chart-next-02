async function run() {
  const listRes = await fetch('http://localhost:4444/api/dashboard/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list-cache-cards', maxCards: 50000 })
  });
  const data = await listRes.json();
  const cards = data.cards || [];
  
  let malformedCrds = [];
  
  for (const card of cards) {
    let finraActive = false;
    let secActive = false;
    let finraInactive = false;
    let secInactive = false;
    let hasFinra = false;
    let hasSec = false;
    
    if (card.statusText) {
       const statusStr = String(card.statusText).toLowerCase();
       hasFinra = statusStr.includes('finra');
       hasSec = statusStr.includes('sec');
       
       const parts = statusStr.split('|');
       for (const p of parts) {
          if (p.includes('finra')) {
             if (p.includes('inactive')) finraInactive = true;
             else finraActive = true;
          }
          if (p.includes('sec')) {
             if (p.includes('inactive')) secInactive = true;
             else secActive = true;
          }
       }
    }
    
    // Check if one is active and the other is inactive
    if (hasFinra && hasSec) {
       if ((finraActive && secInactive) || (finraInactive && secActive)) {
          malformedCrds.push(card);
       }
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
