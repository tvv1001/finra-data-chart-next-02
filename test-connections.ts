import { getFirmConnectionsFromGraph } from './src/lib/graphConnections';

async function main() {
    const res = await getFirmConnectionsFromGraph('316331');
    console.log(JSON.stringify(res, null, 2));
}

main().catch(console.error);
