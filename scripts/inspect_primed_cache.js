const fs = require('fs');
const path = require('path');

const repoPrimedCandidates = [path.join(process.cwd(), 'data', 'national', 'primed-cache'), path.join(process.cwd(), 'data', 'primed-cache')];
const externalPrimedCandidates = [
	path.join('/home/lenny/Dev/webDev', 'Data-finra-sec', 'data', 'national', 'primed-cache'),
	path.join('/home/lenny/Dev/webDev', 'Data-finra-sec', 'data', 'primed-cache'),
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

function scanDir(dir) {
	if (!fs.existsSync(dir)) return [];
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
	const results = [];
	for (const f of files) {
		try {
			const raw = fs.readFileSync(path.join(dir, f), 'utf8');
			const json = JSON.parse(raw || '{}');
			// json may be an object keyed by id or a single object
			if (json && typeof json === 'object' && !Array.isArray(json)) {
				for (const [k, v] of Object.entries(json)) {
					const id = String(k);
					results.push({ id, file: f, content: v });
				}
			}
		} catch (e) {
			// ignore parse errors
		}
	}
	return results;
}

function summarize(entries) {
	const map = new Map();
	for (const e of entries) {
		const id = String(e.id || (e.content && e.content.basicInformation && (e.content.basicInformation.individualId || e.content.basicInformation.crd)) || 'unknown');
		const obj = e.content || {};
		const present = {};
		for (const field of fields) {
			const val = obj[field];
			if (Array.isArray(val)) present[field] = val.length;
			else if (val == null) present[field] = 0;
			else present[field] = 1;
		}
		if (!map.has(id)) map.set(id, { id, files: new Set(), present: Object.assign({}, present) });
		const entry = map.get(id);
		entry.files.add(e.file);
		// merge counts (add lengths when arrays)
		for (const field of fields) {
			const v = present[field];
			if (typeof v === 'number') entry.present[field] = Math.max(entry.present[field] || 0, v);
		}
	}
	return Array.from(map.values()).map((x) => ({ id: x.id, files: Array.from(x.files), present: x.present }));
}

function printReport(name, dirs) {
	for (const dir of dirs) {
		console.log('---', name, dir, '---');
		const entries = scanDir(dir);
		if (!entries.length) {
			console.log('no JSON primed-cache files found');
			continue;
		}
		const sum = summarize(entries);
		sum.sort((a, b) => a.id.localeCompare(b.id));
		for (const s of sum) {
			const missing = fields.filter((f) => !(s.present[f] && s.present[f] > 0));
			console.log(
				`CRD ${s.id}: files=${s.files.join(', ')}; present=${Object.entries(s.present)
					.filter(([k, v]) => v)
					.map(([k, v]) => `${k}:${v}`)
					.join(', ')}${missing.length ? '; missing=' + missing.join(', ') : ''}`,
			);
		}
		console.log('total ids:', sum.length);
	}
}

printReport('repo primed-cache', repoPrimedCandidates);
printReport('external primed-cache', externalPrimedCandidates);
