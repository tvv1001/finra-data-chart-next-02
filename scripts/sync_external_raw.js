#!/usr/bin/env node
/**
 * Sync the latest externally maintained raw FINRA / SEC payloads into the
 * repo-local data/raw directory.
 *
 * Default source:
 *   /home/lenny/Dev/webDev/Data-finra-sec/data/raw
 *
 * Optional env override:
 *   FINRA_EXTERNAL_RAW_DIR=/custom/path npm run data:sync
 *
 * Flags:
 *   --dry-run   Show what would change without copying files
 *   --rebuild   Run scripts/rebuild_local_data.js after sync completes
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_EXTERNAL_RAW_DIR = '/home/lenny/Dev/webDev/Data-finra-sec/data/raw';
const LOCAL_DATA_DIR = path.resolve(__dirname, '..', 'data');
const LOCAL_RAW_DIR = path.join(LOCAL_DATA_DIR, 'raw');
const REPORT_PATH = path.join(LOCAL_DATA_DIR, 'national', 'raw-sync-report.json');
const APPEND_CACHE_SCRIPT = path.resolve(__dirname, 'update_local_cache.js');

function parseArgs(argv) {
	const crds = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--crd' && argv[i + 1]) {
			crds.push(argv[i + 1]);
			i += 1;
			continue;
		}
		if (arg.startsWith('--crd=')) crds.push(arg.slice('--crd='.length));
	}
	return {
		dryRun: argv.includes('--dry-run'),
		rebuild: argv.includes('--rebuild'),
		force: argv.includes('--force'),
		crds: Array.from(new Set(crds.map((value) => String(value || '').trim()).filter(Boolean))),
	};
}

function fileHash(filePath) {
	return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readFileMap(dir) {
	const files = new Map();
	if (!fs.existsSync(dir)) return files;
	for (const name of fs.readdirSync(dir)) {
		if (name.startsWith('.')) continue;
		const filePath = path.join(dir, name);
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) continue;
		files.set(name, {
			filePath,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
		});
	}
	return files;
}

async function ensureDir(dir) {
	await fsp.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
	await ensureDir(path.dirname(filePath));
	await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveSourceDir() {
	return path.resolve(process.env.FINRA_EXTERNAL_RAW_DIR || DEFAULT_EXTERNAL_RAW_DIR);
}

function matchesRequestedCrds(fileName, crds) {
	if (!crds.length) return true;
	return crds.some((crd) => String(fileName).endsWith(`:${crd}.json`));
}

function buildPlan(localFiles, sourceFiles) {
	const missing = [];
	const changed = [];

	for (const [name, sourceInfo] of sourceFiles) {
		const localInfo = localFiles.get(name);
		if (!localInfo) {
			missing.push({ name, reason: 'missing-local' });
			continue;
		}
		if (localInfo.size !== sourceInfo.size) {
			changed.push({
				name,
				reason: 'size-differs',
				localSize: localInfo.size,
				sourceSize: sourceInfo.size,
			});
			continue;
		}
		if (localInfo.mtimeMs !== sourceInfo.mtimeMs) {
			const localHash = fileHash(localInfo.filePath);
			const sourceHash = fileHash(sourceInfo.filePath);
			if (localHash !== sourceHash) {
				changed.push({
					name,
					reason: 'hash-differs',
					localSize: localInfo.size,
					sourceSize: sourceInfo.size,
					localHash,
					sourceHash,
				});
			}
		}
	}

	return { missing, changed };
}

async function copyPlannedFiles(planNames, sourceDir, targetDir) {
	for (const name of planNames) {
		const sourcePath = path.join(sourceDir, name);
		const targetPath = path.join(targetDir, name);
		await fsp.copyFile(sourcePath, targetPath);
		const stat = await fsp.stat(sourcePath);
		await fsp.utimes(targetPath, stat.atime, stat.mtime);
	}
}

function runAppendCache(rawFileNames) {
	if (!rawFileNames.length) return;
	const result = spawnSync(process.execPath, [APPEND_CACHE_SCRIPT, ...rawFileNames.flatMap((name) => ['--file', name])], {
		cwd: path.resolve(__dirname, '..'),
		stdio: 'inherit',
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(`Incremental cache update failed with exit code ${result.status}`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const sourceDir = resolveSourceDir();

	if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
		throw new Error(`External raw source directory not found: ${sourceDir}`);
	}

	await ensureDir(LOCAL_RAW_DIR);
	await ensureDir(path.dirname(REPORT_PATH));

	const localFiles = readFileMap(LOCAL_RAW_DIR);
	const sourceFiles = new Map(Array.from(readFileMap(sourceDir).entries()).filter(([name]) => matchesRequestedCrds(name, options.crds)));
	const plan = buildPlan(localFiles, sourceFiles);
	const forceNames = options.force ? Array.from(sourceFiles.keys()).filter((name) => localFiles.has(name)) : [];
	const copyNames = Array.from(new Set([...plan.missing.map((item) => item.name), ...plan.changed.map((item) => item.name), ...forceNames])).sort();

	const report = {
		generatedAt: new Date().toISOString(),
		sourceDir,
		targetDir: LOCAL_RAW_DIR,
		dryRun: options.dryRun,
		rebuildRequested: options.rebuild,
		force: options.force,
		crds: options.crds,
		counts: {
			sourceFiles: sourceFiles.size,
			localFilesBefore: localFiles.size,
			missing: plan.missing.length,
			changed: plan.changed.length,
			forced: forceNames.length,
			copied: options.dryRun ? 0 : copyNames.length,
		},
		samples: {
			missing: plan.missing.slice(0, 25),
			changed: plan.changed.slice(0, 25),
			forced: forceNames.slice(0, 25),
		},
	};

	if (!options.dryRun && copyNames.length) {
		await copyPlannedFiles(copyNames, sourceDir, LOCAL_RAW_DIR);
	}

	await writeJson(REPORT_PATH, report);

	console.log(`External raw source: ${sourceDir}`);
	console.log(`Repo-local target: ${LOCAL_RAW_DIR}`);
	console.log(`Missing locally: ${plan.missing.length}`);
	console.log(`Changed locally: ${plan.changed.length}`);
	console.log(`Copied: ${options.dryRun ? 0 : copyNames.length}`);
	console.log(`Sync report: ${REPORT_PATH}`);

	if (options.rebuild) {
		if (options.dryRun) {
			console.log('Skipped cache append because --dry-run was requested.');
		} else {
			runAppendCache(copyNames);
		}
	}
}

main().catch((error) => {
	console.error(error.message || error);
	process.exit(1);
});
