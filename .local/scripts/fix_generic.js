const fs = require('fs');
const path = require('path');

const list1 = 'crd-list.csv';
const list2 = 'crd-list-generic.csv';
const rawDir1 = 'data/raw/brokercheck.finra.org';
const rawDir2 = 'data/raw/adviserinfo.sec.gov';

const map = new Map();

function loadCSV(filename) {
    if (!fs.existsSync(filename)) return;
    const lines = fs.readFileSync(filename, 'utf8').split('\n');
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const match = line.match(/^([^,]+),([^,]+),"([^"]*)",(false|true),(false|true),(false|true)$/);
        if (match) {
            const crd = match[2];
            map.set(crd, {
                type: match[1],
                crd: crd,
                name: match[3],
                hasDetail: match[4] === 'true',
                inFinra: match[5] === 'true',
                inSec: match[6] === 'true'
            });
        }
    }
}

loadCSV(list1);
loadCSV(list2);

console.log(`Loaded ${map.size} total CRDs.`);

// Now check raw files to see if we have detail pages
function checkRawFiles(dir, source) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        // e.g. api.brokercheck.finra.org_search_individual_2923813.json
        const match = file.match(/_(firm|individual)_(\d+)\.json$/);
        if (match) {
            const crd = match[2];
            if (map.has(crd)) {
                const entry = map.get(crd);
                entry.hasDetail = true;
                if (source === 'finra') entry.inFinra = true;
                if (source === 'sec') entry.inSec = true;
            } else {
                // If it's not in the map at all, maybe add it? Wait, the user asked to check every CRD in generic. We'll only update existing.
                map.set(crd, {
                    type: match[1],
                    crd: crd,
                    name: '',
                    hasDetail: true,
                    inFinra: source === 'finra',
                    inSec: source === 'sec'
                });
            }
        }
    }
}

console.log("Checking raw FINRA...");
checkRawFiles(rawDir1, 'finra');
console.log("Checking raw SEC...");
checkRawFiles(rawDir2, 'sec');

// Let's also extract names for any newly discovered detail pages if they don't have one!
// But wait, the name should be in the _source.content of the raw file. It's faster to just check.
// I'll skip names for now and just fix the categorization, then I'll use the CSV writer to split them.

const out1 = fs.createWriteStream(list1);
const out2 = fs.createWriteStream(list2);
const header = 'Type,CRD,Name,Has_Detail_Page,In_FINRA,In_SEC\n';
out1.write(header);
out2.write(header);

let genericCount = 0;
let detailCount = 0;

for (const val of map.values()) {
    let safeName = (val.name || '').replace(/"/g, '""');
    const line = `${val.type},${val.crd},"${safeName}",${val.hasDetail},${val.inFinra},${val.inSec}\n`;
    if (val.hasDetail) {
        out1.write(line);
        detailCount++;
    } else {
        out2.write(line);
        genericCount++;
    }
}
out1.end();
out2.end();

console.log(`Finished! Detail: ${detailCount}, Generic: ${genericCount}`);
