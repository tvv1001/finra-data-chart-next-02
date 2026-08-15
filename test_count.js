const fs = require('fs');
const log = JSON.parse(fs.readFileSync('data/national/crd-log.json', 'utf8'));
console.log('Total:', log.individuals.length + log.firms.length);
