import { searchLocalIndex } from './src/lib/localSearch';
async function test() {
  const local = await searchLocalIndex('finra', 'individual', '131856', { limit: 10 });
  console.log("Hits:", local.hits?.hits?.length);
  process.exit(0);
}
test().catch(console.error);
