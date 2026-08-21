import { searchLocalIndex } from './src/lib/localSearch.js';
import path from 'path';

async function run() {
  const result = await searchLocalIndex('albany');
  console.log(result.slice(0, 2));
}

run().catch(console.error);
