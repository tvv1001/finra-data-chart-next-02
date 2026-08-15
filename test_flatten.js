function flattenEmploymentRecords(detail, { includeGeneric = false } = {}) {
	return [
		...(detail?.currentEmployments || []).map((employment) => ({ ...employment, _isCurrent: true })),
		...(detail?.currentIAEmployments || []).map((employment) => ({ ...employment, _isCurrent: true })),
		...(detail?.previousEmployments || []).map((employment) => ({ ...employment, _isCurrent: false })),
		...(detail?.previousIAEmployments || []).map((employment) => ({ ...employment, _isCurrent: false })),
		...(includeGeneric ? detail?.employments || [] : []),
	];
}
const detail = {
  currentEmployments: [ { firmName: "MORGAN" } ],
  previousEmployments: [ { firmName: 'CITI' } ]
};
console.log(flattenEmploymentRecords(detail));
