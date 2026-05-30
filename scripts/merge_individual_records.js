#!/usr/bin/env node
/*
 Merge FINRA + SEC individual raw files into a single merged JSON that
 follows data/schemas/individual-merge.schema.json. Defaults to ID 4240769
 but accepts two args: <finraPath> <secPath>
*/
const fs = require('fs');
const path = require('path');

function readJson(p) {
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch (e) {
		console.error('read error', p, e.message);
		process.exit(2);
	}
}

function uniqueBy(arr, keyFn) {
	const seen = new Set();
	const out = [];
	for (const it of arr || []) {
		const k = keyFn ? keyFn(it) : JSON.stringify(it);
		if (!seen.has(k)) {
			seen.add(k);
			out.push(it);
		}
	}
	return out;
}

function merge(finraRaw, secRaw) {
	const finra = finraRaw && finraRaw.content ? finraRaw.content : finraRaw;
	const sec = secRaw && secRaw.iacontent ? secRaw.iacontent : secRaw;

	// build basicInformation by preferring FINRA when available, but record per-field source
	const basicInformation = {};
	const basicSources = {};
	const finraBasic = finra && finra.basicInformation ? finra.basicInformation : {};
	const secBasic = sec && sec.basicInformation ? sec.basicInformation : {};
	const keys = new Set(Object.keys(finraBasic).concat(Object.keys(secBasic)));
	for (const k of keys) {
		// prefer SEC for IA-prefixed fields (iaScope, iaDisclosureFlag, iaDisclosures, currentIAEmployments...)
		const preferSec = /^ia/i.test(k) || k.toLowerCase().includes('ia');
		if (finraBasic.hasOwnProperty(k) && secBasic.hasOwnProperty(k)) {
			try {
				const fin = JSON.stringify(finraBasic[k]);
				const se = JSON.stringify(secBasic[k]);
				if (fin === se) {
					basicInformation[k] = finraBasic[k];
					basicSources[k] = 'both';
				} else {
					if (preferSec) {
						basicInformation[k] = secBasic[k];
						basicSources[k] = 'sec';
					} else {
						basicInformation[k] = finraBasic[k];
						basicSources[k] = 'finra';
					}
				}
			} catch (e) {
				basicInformation[k] = finraBasic[k] || secBasic[k];
				basicSources[k] = finraBasic[k] ? 'finra' : 'sec';
			}
		} else if (finraBasic.hasOwnProperty(k)) {
			basicInformation[k] = finraBasic[k];
			basicSources[k] = 'finra';
		} else {
			basicInformation[k] = secBasic[k];
			basicSources[k] = 'sec';
		}
	}

	// also merge IA-specific employment lists
	const finraCurrentIA = finra && finra.currentIAEmployments ? finra.currentIAEmployments : [];
	const secCurrentIA = sec && sec.currentIAEmployments ? sec.currentIAEmployments : [];
	const mapCurrentIA = new Map();
	for (const it of finraCurrentIA) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.city || '');
		mapCurrentIA.set(key, Object.assign({}, it, { _source: 'finra' }));
	}
	for (const it of secCurrentIA) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.city || '');
		if (mapCurrentIA.has(key)) {
			const merged = Object.assign({}, mapCurrentIA.get(key), it);
			merged._source = 'both';
			mapCurrentIA.set(key, merged);
		} else {
			mapCurrentIA.set(key, Object.assign({}, it, { _source: 'sec' }));
		}
	}
	const currentIAEmployments = Array.from(mapCurrentIA.values());

	// merge employments and tag each item with a source: finra, sec, or both
	const finraCurrent = finra && finra.currentEmployments ? finra.currentEmployments : [];
	const secCurrent = sec && sec.currentEmployments ? sec.currentEmployments : [];
	const mapCurrent = new Map();
	for (const it of finraCurrent) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.city || '');
		mapCurrent.set(key, Object.assign({}, it, { _source: 'finra' }));
	}
	for (const it of secCurrent) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.city || '');
		if (mapCurrent.has(key)) {
			// present in both -> mark both
			const merged = Object.assign({}, mapCurrent.get(key), it);
			merged._source = 'both';
			mapCurrent.set(key, merged);
		} else {
			mapCurrent.set(key, Object.assign({}, it, { _source: 'sec' }));
		}
	}
	const currentEmployments = Array.from(mapCurrent.values());

	const finraPrev = finra && finra.previousEmployments ? finra.previousEmployments : [];
	const secPrev = sec && sec.previousEmployments ? sec.previousEmployments : [];
	const mapPrev = new Map();
	for (const it of finraPrev) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.registrationBeginDate || '') + '|' + (it.registrationEndDate || '');
		mapPrev.set(key, Object.assign({}, it, { _source: 'finra' }));
	}
	for (const it of secPrev) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.registrationBeginDate || '') + '|' + (it.registrationEndDate || '');
		if (mapPrev.has(key)) {
			const merged = Object.assign({}, mapPrev.get(key), it);
			merged._source = 'both';
			mapPrev.set(key, merged);
		} else {
			mapPrev.set(key, Object.assign({}, it, { _source: 'sec' }));
		}
	}
	const previousEmployments = Array.from(mapPrev.values());

	// merge previous IA employments
	const finraPrevIA = finra && finra.previousIAEmployments ? finra.previousIAEmployments : [];
	const secPrevIA = sec && sec.previousIAEmployments ? sec.previousIAEmployments : [];
	const mapPrevIA = new Map();
	for (const it of finraPrevIA) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.registrationBeginDate || '') + '|' + (it.registrationEndDate || '');
		mapPrevIA.set(key, Object.assign({}, it, { _source: 'finra' }));
	}
	for (const it of secPrevIA) {
		const key = it.firmId || (it.firmName || '') + '|' + (it.registrationBeginDate || '') + '|' + (it.registrationEndDate || '');
		if (mapPrevIA.has(key)) {
			const merged = Object.assign({}, mapPrevIA.get(key), it);
			merged._source = 'both';
			mapPrevIA.set(key, merged);
		} else {
			mapPrevIA.set(key, Object.assign({}, it, { _source: 'sec' }));
		}
	}
	const previousIAEmployments = Array.from(mapPrevIA.values());

	return {
		mergeMeta: {
			mergedAt: new Date().toISOString(),
			preferredSource: 'finra',
		},
		sources: {
			finra: Boolean(finraRaw) ? { rawPath: 'data/raw/finra:individual:4240769.json' } : null,
			sec: Boolean(secRaw) ? { rawPath: 'data/raw/sec:individual:4240769.json' } : null,
		},
		basicInformation,
		basicInformationSources: basicSources,
		currentEmployments,
		currentIAEmployments,
		previousEmployments,
		previousIAEmployments,
		raw: {
			finraRawPath: 'data/raw/finra:individual:4240769.json',
			secRawPath: 'data/raw/sec:individual:4240769.json',
		},
	};
}

function main() {
	const defaultFinra = path.resolve(__dirname, '..', 'data', 'raw', 'finra:individual:4240769.json');
	const defaultSec = path.resolve(__dirname, '..', 'data', 'raw', 'sec:individual:4240769.json');
	const outPath = path.resolve(__dirname, '..', 'data', 'derived', 'merged-individual-4240769.json');

	const finraPath = process.argv[2] || defaultFinra;
	const secPath = process.argv[3] || defaultSec;

	const finra = fs.existsSync(finraPath) ? readJson(finraPath) : null;
	const sec = fs.existsSync(secPath) ? readJson(secPath) : null;

	const merged = merge(finra, sec);

	fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');
	console.log('Wrote merged file to', outPath);
}

if (require.main === module) main();

// export for programmatic use
module.exports = { merge, readJson };
