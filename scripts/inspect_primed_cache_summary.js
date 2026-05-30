const fs = require('fs');
const path = require('path');

const dirs = [
	path.join(process.cwd(), 'data', 'primed-cache'),
	path.join(process.cwd(), 'data', 'national', 'primed-cache'),
	path.join('/home/lenny/Dev/webDev', 'Data-finra-sec', 'data', 'primed-cache'),
	path.join('/home/lenny/Dev/webDev', 'Data-finra-sec', 'data', 'national', 'primed-cache'),
	path.join('/home/lenny/Dev/webDev', 'Data-finra-sec', 'primed-cache'),
];

const fields = [
	'basicInformation',
	'currentEmployments',
	'previousEmployments',
	'currentIAEmployments',
	'previousIAEmployments',
	'disclosures',
	'iaDisclosures',
	'registeredStates',
	'registeredSROs',
	'registrationCount',
	'examsCount',
	'brokerDetails',
	'otherNames',
];

function scanSingleDir(dir) {
	if (!fs.existsSync(dir)) return [];
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
	const entries = [];
	for (const f of files) {
		try {
			const raw = fs.readFileSync(path.join(dir, f), 'utf8');
			const json = JSON.parse(raw || '{}');
			for (const [k, v] of Object.entries(json)) {
				entries.push({ id: String(k), file: f, content: v, dir });
			}
		} catch (e) {}
	}
	return entries;
}

let all = [];
for (const d of dirs) {
	all = all.concat(scanSingleDir(d));
}

const map = new Map();
for (const e of all) {
	const id = e.id;
	const obj = e.content || {};
	if (!map.has(id)) map.set(id, { id, dirs: new Set(), files: new Set(), present: {} });
	const rec = map.get(id);
	rec.dirs.add(e.dir);
	rec.files.add(e.file);
	for (const f of fields) {
		const val = obj[f];
		rec.present[f] = rec.present[f] || 0;
		if (Array.isArray(val)) rec.present[f] = Math.max(rec.present[f], val.length);
		else if (val != null) rec.present[f] = Math.max(rec.present[f], 1);
	}
}

const results = Array.from(map.values());
const totalIds = results.length;
let idsMissingAny = 0;
const fieldMissingCounts = {};
for (const f of fields) fieldMissingCounts[f] = 0;
for (const r of results) {
	const missing = fields.filter((f) => !(r.present[f] && r.present[f] > 0));
	if (missing.length) idsMissingAny++;
	for (const f of missing) fieldMissingCounts[f]++;
}

console.log('scanned dirs:', dirs.filter((d) => fs.existsSync(d)).join(', ') || '(none found)');
console.log('total ids found:', totalIds);
console.log('ids missing any of fields:', idsMissingAny);
console.log('missing counts by field:');
for (const f of fields) console.log(`  ${f}: ${fieldMissingCounts[f]}`);

// list a few sample ids missing employments
const sample = results
	.filter((r) => !(r.present.currentEmployments && r.present.currentEmployments > 0))
	.slice(0, 20)
	.map((r) => ({ id: r.id, files: Array.from(r.files).slice(0, 3) }));
console.log('\nSample ids missing currentEmployments (up to 20):');
console.log(sample.slice(0, 20));

// write JSON report
try {
	fs.writeFileSync(path.join(process.cwd(), 'tmp', 'primed-cache-summary.json'), JSON.stringify({ totalIds, idsMissingAny, fieldMissingCounts, sample }, null, 2));
	console.log('\nWrote tmp/primed-cache-summary.json');
} catch (e) {
	console.log('failed to write tmp report:', e.message);
}
