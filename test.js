async function test() {
  const firmId = '10111';
  const extUrl = `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&nrows=100&includePrevious=true`;
  const extRes = await fetch(extUrl);
  const extData = await extRes.json();
  console.log(extData.hits.hits.length);
  const first = extData.hits.hits[0];
  console.log(JSON.stringify(first, null, 2));
}
test();
