const { searchExternalFallback } = require('./src/lib/searchExternalFallback');
async function test() {
  const result = await searchExternalFallback('finra', 'individual', 'tubacex', 'http://localhost:4444');
  console.log(JSON.stringify(result, null, 2));
}
test();
