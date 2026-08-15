function isPlainObject(value) {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}
function mergePreferPrimary(primary, secondary) {
	if (primary == null || primary === '') return secondary;
	if (secondary == null || secondary === '') return primary;
	if (Array.isArray(primary) && Array.isArray(secondary)) {
		if (!primary.length) return secondary;
		if (!secondary.length) return primary;
		const seen = new Set(primary.map((item) => JSON.stringify(item)));
		return [
			...primary,
			...secondary.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		];
	}
	if (isPlainObject(primary) && isPlainObject(secondary)) {
		const merged = { ...primary };
		for (const [key, value] of Object.entries(secondary)) {
			merged[key] = key in merged ? mergePreferPrimary(merged[key], value) : value;
		}
		return merged;
	}
	return primary;
}

const finra = { previousEmployments: [ { firmName: "CITI" } ] };
const sec = { iacontent: "{\"foo\":\"bar\"}" }; // not parsed

const merged = mergePreferPrimary(sec, finra);
console.log(merged);
