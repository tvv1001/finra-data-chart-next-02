async function run() {
    const res = await fetch('http://localhost:4444/api/finra/graph');
    const graph = await res.json();
    const stubs = graph.nodes.filter(n => n.stub || (n.hasFinraData === false && n.hasSecData === false)).map(n => n.id);
    console.log(`Redis graph has ${graph.nodes.length} nodes, of which ${stubs.length} are stubs.`);
    if (stubs.length > 0) {
        console.log(stubs.slice(0, 10));
    }
}
run().catch(console.error);
