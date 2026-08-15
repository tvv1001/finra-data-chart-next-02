const fs = require('fs');
const graph = JSON.parse(fs.readFileSync('data/national/finra-graph.json', 'utf8'));
const stubs = graph.nodes.filter(n => n.stub || (n.hasFinraData === false && n.hasSecData === false)).map(n => n.id);
console.log(`Graph has ${graph.nodes.length} nodes, of which ${stubs.length} are stubs.`);
if (stubs.length > 0) {
    console.log(stubs.slice(0, 10));
}
