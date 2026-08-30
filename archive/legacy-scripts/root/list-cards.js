async function run() {
    const res = await fetch('http://localhost:4444/api/dashboard/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list-cache-cards', maxCards: 10000 })
    });
    const data = await res.json();
    const missingCrds = data.cards.filter(c => c.sources.length === 0 || c.sources.every(s => s.status !== 'ok')).map(c => c.id);
    console.log(`Found ${missingCrds.length} missing CRDs`);
    console.log(missingCrds.slice(0, 10));
}
run().catch(console.error);
