async function run() {
  const listRes = await fetch('http://localhost:4444/api/dashboard/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list-cache-cards', maxCards: 50 })
  });
  const data = await listRes.json();
  const cards = data.cards || [];
  console.log(JSON.stringify(cards.slice(0,2), null, 2));
}
run().catch(console.error);
