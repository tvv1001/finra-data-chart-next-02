const fs = require('fs');
const path = require('path');

const crds = { firm: ['152665'], ind: ['8319988', '8322765', '8322791', '8324166', '8320699', '8321466', '8321617', '8323657', '8323027', '8322775', '8322626', '8322229', '8322075', '8320474'] };

async function fetchAndSave(type, crd) {
    const finraUrl = `https://api.brokercheck.finra.org/search/${type}/${crd}?hl=true&includePrevious=true&wt=json`;
    const secUrl = `https://api.adviserinfo.sec.gov/search/${type}/${crd}?hl=true&includePrevious=true&wt=json`;

    const finraPath = path.join(__dirname, `data/raw/brokercheck.finra.org/api.brokercheck.finra.org_search_${type}_${crd}.json`);
    const secPath = path.join(__dirname, `data/raw/adviserinfo.sec.gov/api.adviserinfo.sec.gov_search_${type}_${crd}.json`);

    try {
        const finraRes = await fetch(finraUrl);
        if (finraRes.ok) {
            fs.mkdirSync(path.dirname(finraPath), { recursive: true });
            fs.writeFileSync(finraPath, await finraRes.text());
        }
    } catch (e) { console.error('Error FINRA', crd, e.message); }

    try {
        const secRes = await fetch(secUrl);
        if (secRes.ok) {
            fs.mkdirSync(path.dirname(secPath), { recursive: true });
            fs.writeFileSync(secPath, await secRes.text());
        }
    } catch (e) { console.error('Error SEC', crd, e.message); }
}

async function run() {
    for (const crd of crds.firm) await fetchAndSave('firm', crd);
    for (const crd of crds.ind) await fetchAndSave('individual', crd);
    console.log('Done!');
}
run();
