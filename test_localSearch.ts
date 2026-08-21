import { searchLocalIndex } from './src/lib/localSearch.ts';

searchLocalIndex('finra', 'individual', 'albany').then(console.log).catch(console.error);
