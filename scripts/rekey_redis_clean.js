/**
 * Migrates all Redis keys of the form "source:type:CRD:queryString" to the clean
 * format "source:type:CRD".  Safe to re-run: keys already in clean format are skipped.
 *
 * Usage:
 *   node scripts/rekey_redis_clean.js [--dry-run]
 */
'use strict';
const path = require('path');
const { Redis } = require('@upstash/redis');

const isDryRun = process.argv.includes('--dry-run');

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Matches keys with a query-string suffix after the CRD
const SUFFIXED_KEY_RE = /^(finra|sec):(individual|firm):(\d{1,10}|8-\d+):(.+)$/;

async function scan(pattern) {
	const keys = [];
	let cursor = 0;
	do {
		const [nextCursor, batch] = await redis.scan(cursor, { match: pattern, count: 500 });
		cursor = typeof nextCursor === 'string' ? parseInt(nextCursor, 10) : Number(nextCursor);
		keys.push(...batch);
	} while (cursor !== 0);
	return keys;
}

async function main() {
	const patterns = [
		'finra:individual:*',
		'sec:individual:*',
		'finra:firm:*',
		'sec:firm:*',
	];

	let totalScanned = 0;
	let totalMigrated = 0;
	let totalSkipped = 0;
	let totalErrors = 0;

	for (const pattern of patterns) {
		console.log(`\nScanning pattern: ${pattern}`);
		const keys = await scan(pattern);
		console.log(`  Found ${keys.length} keys`);

		for (const key of keys) {
			totalScanned++;
			const match = SUFFIXED_KEY_RE.exec(key);
			if (!match) {
				// Already clean
				totalSkipped++;
				continue;
			}
			const cleanKey = `${match[1]}:${match[2]}:${match[3]}`;

			try {
				const existing = await redis.exists(cleanKey);
				if (existing) {
					// Clean key already exists — just delete the suffixed duplicate
					if (!isDryRun) await redis.del(key);
					console.log(`  [dup-del] ${key} → ${cleanKey} (clean key already existed)`);
					totalMigrated++;
					continue;
				}

				// Get the value from the old suffixed key
				const raw = await redis.get(key);
				if (raw === null) {
					totalSkipped++;
					continue;
				}
				const ttl = await redis.ttl(key);
				const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
				if (!isDryRun) {
					if (ttl > 0) {
						await redis.set(cleanKey, value, { ex: ttl });
					} else {
						await redis.set(cleanKey, value, { ex: 60 * 60 * 24 });
					}
					await redis.del(key);
				}
				console.log(`  [migrated] ${key} → ${cleanKey}${isDryRun ? ' (dry-run)' : ''}`);
				totalMigrated++;
			} catch (err) {
				console.error(`  [error] ${key}: ${err.message}`);
				totalErrors++;
			}
		}
	}

	console.log(`\nDone.`);
	console.log(`  Scanned:  ${totalScanned}`);
	console.log(`  Migrated: ${totalMigrated}`);
	console.log(`  Skipped:  ${totalSkipped}`);
	console.log(`  Errors:   ${totalErrors}`);
	if (isDryRun) console.log('\n(dry-run mode — no changes were written)');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
