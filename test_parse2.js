const { Redis } = require('@upstash/redis');
const zlib = require('zlib');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isPlainObject(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }

function getEmbeddedContentObject(source, contentKeys = ['content', 'iacontent']) {
	if (!isPlainObject(source)) return null;
	for (const key of contentKeys) {
		const raw = source[key];
		if (raw == null) continue;
		if (isPlainObject(raw)) return raw;
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				if (isPlainObject(parsed)) return parsed;
			} catch (e) { return null; }
		}
	}
	return null;
}

function toArray(value) {
	if (Array.isArray(value)) return value;
	if (value == null || value === '') return [];
	return [value];
}

function mergeUniqueArrays(arr1, arr2) {
	if (!arr1?.length) return arr2 || [];
	if (!arr2?.length) return arr1 || [];
	const seen = new Set(arr1.map((item) => JSON.stringify(item)));
	return [ ...arr1, ...arr2.filter((item) => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; }) ];
}

function normalize(detail) {
	const normalized = { ...detail };
	const currentEmployments = mergeUniqueArrays(toArray(normalized.currentEmployments), toArray(normalized.ind_current_employments));
	const previousEmployments = mergeUniqueArrays(toArray(normalized.previousEmployments), toArray(normalized.ind_previous_employments));
    console.log("Current Employments:", currentEmployments);
    console.log("Previous Employments:", previousEmployments);
    return normalized;
}

async function run() {
  const finraRaw = await redis.get('finra:individual:4317416');
  if (typeof finraRaw === 'string') {
    const d = zlib.brotliDecompressSync(Buffer.from(finraRaw.slice(3), 'base64')).toString();
    const data = JSON.parse(d);
    const source = data.hits.hits[0]._source;
    const embedded = getEmbeddedContentObject(source);
    try {
        normalize(embedded);
    } catch (e) {
        console.log("ERROR:", e);
    }
  }
}
run();
