const fs = require('fs');
const content = fs.readFileSync('./src/lib/finra-graph.ts', 'utf8');
const unwrapMatch = content.match(/function unwrapDetailPayload[\s\S]*?\n\}/);
const code = unwrapMatch[0] + '\nmodule.exports = { unwrapDetailPayload };';
fs.writeFileSync('./unwrap.js', code);
