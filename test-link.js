const { readFileSync } = require('fs');
const content = readFileSync('./src/lib/finra-graph.ts', 'utf8');

const regex = /function isAutoExpansionLink[\s\S]*?\n\}/;
const match = content.match(regex);
console.log(match[0]);
