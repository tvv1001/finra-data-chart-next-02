import * as path from 'node:path';
import fs from 'node:fs';

// Prefer the repo-local `data/` directory by default so runtime API routes and
// rebuild scripts read the same cache tree. Developers can still point the app
// at a different data directory explicitly via FINRA_DATA_DIR.
const DATA_DIR_CANDIDATES = [path.resolve(process.cwd(), 'data'), process.env.FINRA_DATA_DIR].filter(Boolean) as string[];
let resolvedDataDir = path.resolve(process.cwd(), 'data');
for (const p of DATA_DIR_CANDIDATES) {
	try {
		if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
			resolvedDataDir = p;
			break;
		}
	} catch (e) {
		// ignore and continue
	}
}

export const DATA_DIR = resolvedDataDir;
export const GRAPH_FILE = path.join(DATA_DIR, 'national', 'finra-graph.json');
export const SEEDS_FILE = path.join(DATA_DIR, 'national', 'finra-seeds.json');
export const SEED_BANK_FILE = path.join(DATA_DIR, 'national', 'finra-seed-bank.json');
export const RECENT_SEEDS_FILE = path.join(DATA_DIR, 'national', 'finra-recent-seeds.json');
export const PRIMED_CACHE_DIR = path.join(DATA_DIR, 'national', 'primed-cache');
export const SEED_PROFILES_FILE = path.join(DATA_DIR, 'seed-profiles.json');

// Python scrapers live in the original server directory
export const SCRAPER_PATH = path.resolve(process.cwd(), '..', 'finra-data-chart', 'server', 'services', 'crawler', 'finraScraper.py');
export const ANTI_SCRAPER_PATH = path.resolve(process.cwd(), '..', 'finra-data-chart', 'server', 'services', 'crawler', 'anti_bot_scraper.py');

export const DEFAULT_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (compatible; research-tool/1.0)',
	'Accept': 'application/json',
};
