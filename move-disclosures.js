const fs = require('fs');

const content = fs.readFileSync('src/app/dashboard/page.tsx', 'utf8');
const lines = content.split('\n');

const startStr = '{detailedMainRecord?.disclosureSummary && detailedMainRecord.disclosureSummary.length > 0 && (';

let startIndex = -1;
let endIndex = -1;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startStr)) {
        startIndex = i;
        // find matching end
        let braceCount = 0;
        let parenCount = 0;
        let found = false;
        for (let j = i; j < lines.length; j++) {
            for (let k = 0; k < lines[j].length; k++) {
                if (lines[j][k] === '{') braceCount++;
                if (lines[j][k] === '}') braceCount--;
                if (lines[j][k] === '(') parenCount++;
                if (lines[j][k] === ')') parenCount--;
            }
            if (j > i && braceCount === 0 && parenCount === 0 && lines[j].trim() === ')}') {
                endIndex = j;
                found = true;
                break;
            }
        }
        if (found) break;
    }
}

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find disclosures block');
    process.exit(1);
}

const block = lines.slice(startIndex, endIndex + 1);
lines.splice(startIndex, endIndex - startIndex + 1);

// Now find where to insert it. We want it at the very bottom of the card view.
// It should be inside the `detailedMainRecord ? <> ... </> : <div className={styles.readableCardEmpty}>`
// So we find `<div className={styles.readableCardEmpty}>No readable fields found for this record.</div>}`
let insertIndex = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<div className={styles.readableCardEmpty}>No readable fields found for this record.</div>}')) {
        // This line is: 									:	<div className={styles.readableCardEmpty}>No readable fields found for this record.</div>}
        // Let's insert it before the closing `</>` which should be 2 lines above
        if (lines[i-1].trim() === '</>' && lines[i-2].trim() === '}') {
            // Wait, we want to insert inside the `<> ... </>` of `detailedMainRecord`
            // Let's look at lines[i-1].
            if (lines[i-1].trim() === '</>') {
                insertIndex = i - 1;
                break;
            }
        }
    }
}

if (insertIndex !== -1) {
    // Add some empty lines before
    block.unshift('');
    lines.splice(insertIndex, 0, ...block);
    fs.writeFileSync('src/app/dashboard/page.tsx', lines.join('\n'));
    console.log('Successfully moved disclosures block');
} else {
    console.error('Could not find insert point');
    process.exit(1);
}
