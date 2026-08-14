const fs = require('fs');

function firstNonEmpty(...values) {
	for (const value of values) {
		const text = String(value ?? '').trim();
		if (text && text !== 'undefined' && text !== 'null') return text;
	}
	return '';
}

async function run() {
  const firmId = '10111';
  const extUrl = `https://api.brokercheck.finra.org/search/individual?firm=${firmId}&hl=true&wt=json&nrows=100&includePrevious=true`;
  const extRes = await fetch(extUrl);
  const extData = await extRes.json();
  
  const extHits = (extData.hits.hits || []).map((hit) => {
					const sourceObj = hit?._source || hit || {};
					return {
						...sourceObj,
						ind_previous_employments: hit?.inner_hits?.ind_previous_employments?.hits?.hits?.map((h) => h._source) || [],
						ind_ia_previous_employments: hit?.inner_hits?.ind_ia_previous_employments?.hits?.hits?.map((h) => h._source) || [],
						ind_current_employments: hit?.inner_hits?.ind_current_employments?.hits?.hits?.map((h) => h._source) || sourceObj.ind_current_employments || []
					};
				});

  let previous = 0;
  for (const src of extHits) {
    const crd = firstNonEmpty(src.ind_source_id, src.ind_crd, src.individualId, src.id);
    const prev = [
        ...(src.ind_previous_employments || []),
        ...(src.ind_ia_previous_employments || []),
    ];
    const matchedPrev = prev.find((e) => firstNonEmpty(e?.firmId, e?.firm_id) === firmId);
    if (matchedPrev) previous++;
  }
  console.log('Previous matched:', previous);
}
run();
