/**
 * Bulk-uploads all local data/national/ JSON files to Redis as clean keys.
 * Key format: finra:individual:CRD, sec:individual:CRD, finra:firm:CRD, sec:firm:CRD
 *
 * Usage:
 *   node scripts/upload_all_to_redis.js [--dry-run] [--force]
 *
 * --dry-run  Preview what would be uploaded without writing
 * --force    Overwrite existing Redis keys even if unchanged
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { Redis } = require('@upstash/redis');

const isDryRun = process.argv.includes('--dry-run');
const isForce = process.argv.includes('--force');
const BATCH_SIZE = 20; // concurrent uploads
const TTL = 60 * 60 * 24 * 30; // 30 days

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const zlib = require('node:zlib');

const SOURCES = [
	{
		dir: path.join(process.cwd(), 'data', 'national', 'brokercheck.finra.org'),
		prefix: 'api.brokercheck.finra.org_search_',
		source: 'finra',
	},
	{
		dir: path.join(process.cwd(), 'data', 'national', 'adviserinfo.sec.gov'),
		prefix: 'api.adviserinfo.sec.gov_search_',
		source: 'sec',
	},
];

function fileNameToRedisKey(fileName, source) {
	// api.brokercheck.finra.org_search_individual_1046234.json → finra:individual:1046234
	const match = /^api\.(?:brokercheck\.finra\.org|adviserinfo\.sec\.gov)_search_(individual|firm)_(\d{1,10})\.json$/i.exec(fileName);
	if (!match) return null;
	return `${source}:${match[1]}:${match[2]}`;
}

function compressForRedis(str) {
	if (typeof str !== 'string') str = String(str);
	const rawByteLen = Buffer.byteLength(str, 'utf-8');
	if (rawByteLen <= 512) return { finalValue: str, compressed: false, byteLen: rawByteLen };
	const compressed = zlib.brotliCompressSync(Buffer.from(str, 'utf-8'));
	return { finalValue: 'br:' + compressed.toString('base64'), compressed: true, byteLen: compressed.length };
}

function decompressIfBr(val) {
	if (typeof val !== 'string') return typeof val === 'object' ? JSON.stringify(val) : String(val);
	if (val.startsWith('br:')) {
		try {
			const buf = Buffer.from(val.slice(3), 'base64');
			return zlib.brotliDecompressSync(buf).toString('utf-8');
		} catch (e) {
			return val;
		}
	}
	return val;
}

async function processInBatches(items, batchSize, fn) {
	for (let i = 0; i < items.length; i += batchSize) {
		await Promise.all(items.slice(i, i + batchSize).map(fn));
	}
}

async function main() {
	let totalFiles = 0,
		uploaded = 0,
		skipped = 0,
		unchanged = 0,
		errors = 0;

	for (const src of SOURCES) {
		let files;
		try {
			files = fs.readdirSync(src.dir).filter((f) => f.endsWith('.json'));
		} catch {
			console.warn(`Directory not found: ${src.dir}`);
			continue;
		}

		console.log(`\n[${src.source}] ${files.length} files in ${src.dir}`);
		totalFiles += files.length;

		const items = files.map((f) => ({ file: f, key: fileNameToRedisKey(f, src.source), filePath: path.join(src.dir, f) })).filter(({ key }) => key !== null);

		await processInBatches(items, BATCH_SIZE, async ({ file, key, filePath }) => {
			try {
				const content = fs.readFileSync(filePath, 'utf8');
				// Validate JSON
				let parsed;
				try {
					parsed = JSON.parse(content);
				} catch {
					errors++;
					return;
				}

				// Skip empty-hits payloads
				const hits = parsed?.hits;
				if (hits && typeof hits.total === 'number' && hits.total === 0 && Array.isArray(hits.hits) && hits.hits.length === 0) {
					skipped++;
					return;
				}

				if (!isForce) {
					// Check if key already exists and is identical (decompress if stored with br:)
					const existing = await redis.get(key).catch(() => null);
					if (existing != null) {
						const existingStr = decompressIfBr(existing);
						const newStr = JSON.stringify(parsed);
						if (existingStr === newStr) {
							unchanged++;
							return;
						}
					}
				}

				if (!isDryRun) {
					const newStr = JSON.stringify(parsed);
					// compare to existing (decompress if stored with br:)
					if (!isForce) {
						// existing already fetched above when not force; but re-check here to be safe
					}
					const compressed = compressForRedis(newStr);
					await redis.set(key, compressed.finalValue, { ex: TTL });
				}
				uploaded++;
				if (uploaded % 500 === 0) {
					console.log(`  ... ${uploaded} uploaded, ${unchanged} unchanged, ${skipped} skipped, ${errors} errors`);
				}
			} catch (err) {
				errors++;
				console.error(`  [error] ${key}: ${err.message}`);
			}
		});
	}

	console.log(`\n=== Done ===`);
	console.log(`Total files:  ${totalFiles}`);
	console.log(`Uploaded:     ${uploaded}`);
	console.log(`Unchanged:    ${unchanged}`);
	console.log(`Skipped:      ${skipped}`);
	console.log(`Errors:       ${errors}`);
	if (isDryRun) console.log('\n(dry-run — no writes made)');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
