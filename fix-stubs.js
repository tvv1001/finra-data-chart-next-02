async function run() {
    console.log("Fetching local graph...");
    const res = await fetch('http://localhost:4444/api/finra/graph');
    if (!res.ok) {
        console.error("Failed to fetch graph");
        return;
    }
    const graph = await res.json();
    const stubs = [];
    
    for (const node of (graph.nodes || [])) {
        if (node.stub || (node.hasFinraData === false && node.hasSecData === false) || (!node.hasFinraData && !node.hasSecData && node._source === 'dashboard-fetch')) {
            stubs.push(node.id);
        }
    }
    
    // Deduplicate and filter CRDs
    const uniqueCrds = Array.from(new Set(stubs.map(id => id.split(':')[1]).filter(c => /^\d{1,10}$/.test(c))));
    console.log(`Found ${uniqueCrds.length} stub/non-live CRDs to fetch.`);
    
    for (let i = 0; i < uniqueCrds.length; i++) {
        const crd = uniqueCrds[i];
        console.log(`[${i+1}/${uniqueCrds.length}] Fetching CRD ${crd}...`);
        const fetchRes = await fetch('http://localhost:4444/api/dashboard/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'fetch-crds', crds: [crd] })
        });
        const result = await fetchRes.json();
        console.log(`Result for ${crd}:`, result?.summary || result);
        
        // Sleep between requests to avoid rate limits
        await new Promise(r => setTimeout(r, Math.random() * 2000 + 3000)); // 3-5 seconds jitter
    }
    
    console.log("Finished syncing stubs.");
}

run().catch(console.error);
