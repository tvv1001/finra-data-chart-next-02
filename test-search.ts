import { lookupFirmNamesFromSearchSidecar } from './src/lib/localSearch';

async function main() {
    console.log("Testing search sidecar...");
    try {
        const hits = await lookupFirmNamesFromSearchSidecar(['123']);
        console.log("Success:", hits.size);
    } catch (e) {
        console.error("Error:", e);
    }
}
main();
