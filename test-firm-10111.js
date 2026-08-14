require('ts-node').register({ transpileOnly: true, compilerOptions: { module: "commonjs" } });
const { getFirmConnectionsFromGraph } = require('./src/lib/graphConnections.ts');

async function main() {
  const result = await getFirmConnectionsFromGraph('10111');
  console.log("Current:", result.currentConnections.length);
  console.log("Previous:", result.previousConnections.length);
}
main().catch(console.error).finally(() => process.exit(0));
