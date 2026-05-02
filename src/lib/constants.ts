import path from "node:path";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const GRAPH_FILE = path.join(DATA_DIR, "national", "finra-graph.json");
export const SEEDS_FILE = path.join(DATA_DIR, "national", "finra-seeds.json");
export const SEED_PROFILES_FILE = path.join(DATA_DIR, "seed-profiles.json");

// Python scrapers live in the original server directory
export const SCRAPER_PATH = path.resolve(
  process.cwd(),
  "..",
  "finra-data-chart",
  "server",
  "services",
  "crawler",
  "finraScraper.py",
);
export const ANTI_SCRAPER_PATH = path.resolve(
  process.cwd(),
  "..",
  "finra-data-chart",
  "server",
  "services",
  "crawler",
  "anti_bot_scraper.py",
);

export const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; research-tool/1.0)",
  Accept: "application/json",
};
