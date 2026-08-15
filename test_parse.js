const { Redis } = require('@upstash/redis');
const zlib = require('zlib');

// Try to use the compiled ts output if possible, but let's just copy the parseDetailPayload logic.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isPlainObject(value) {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

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
			} catch (e) {
                console.log("Error parsing raw", e);
				return null;
			}
		}
	}
	return null;
}

async function run() {
  const finraRaw = await redis.get('finra:individual:4317416');
  if (typeof finraRaw === 'string' && finraRaw.startsWith('br:')) {
    const d = zlib.brotliDecompressSync(Buffer.from(finraRaw.slice(3), 'base64')).toString();
    const data = JSON.parse(d);
    const source = data.hits.hits[0]._source;
    
    console.log("Source typeof", typeof source);
    const embedded = getEmbeddedContentObject(source, ['content', 'iacontent']);
    console.log("Embedded typeof", typeof embedded);
    if (!embedded) {
        console.log("Why is embedded null?");
        console.log("source.content type:", typeof source.content);
        if (typeof source.content === 'string') {
            console.log("source.content start:", source.content.slice(0, 100));
        }
    }
  }
}
run();
