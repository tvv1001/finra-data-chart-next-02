async function run() {
    const res = await fetch("http://localhost:4444/search-indexes/search-index.sec.firm.json.gz");
    console.log("headers:", Array.from(res.headers.entries()));
    const buf = await res.arrayBuffer();
    console.log("Buffer length:", buf.byteLength);
    // try reading first bytes
    const view = new Uint8Array(buf);
    console.log("First bytes:", view.slice(0, 4));
}
run();
