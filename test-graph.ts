import { getFirmConnectionsFromGraph } from './src/lib/graphConnections';
async function run() {
  const res = await getFirmConnectionsFromGraph('10111');
  console.log(res.previousConnections.length);
  console.log(res.currentConnections.length);
}
run();
