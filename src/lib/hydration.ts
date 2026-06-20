import { setStringIfValid } from '@/lib/redisCache';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const HYDRATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown per ID to avoid repeated fetches
const lastHydrated = new Map<string, number>();

interface QueueItem {
	type: 'individual' | 'firm';
	id: string;
}

const hydrationQueue: QueueItem[] = [];
let isProcessing = false;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAndSave(
	source: 'finra' | 'sec',
	type: 'individual' | 'firm',
	id: string
) {
	const isFinra = source === 'finra';
	const isIndividual = type === 'individual';
	
	const url =
		isFinra && isIndividual ? `https://api.brokercheck.finra.org/search/individual/${id}?hl=true&includePrevious=true&wt=json`
		: isFinra && !isIndividual ? `https://api.brokercheck.finra.org/search/firm/${id}?hl=true&wt=json`
		: !isFinra && isIndividual ? `https://api.adviserinfo.sec.gov/search/individual/${id}?hl=true&includePrevious=true&wt=json`
		: `https://api.adviserinfo.sec.gov/search/firm/${id}?wt=json`;

	const fetchOptions = {
		headers: {
			'Accept': 'application/json',
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'Referer': isFinra ? 'https://brokercheck.finra.org/' : 'https://adviserinfo.sec.gov/',
		},
	};

	console.log(`[Hydration] Time: ${new Date().toISOString()} | Accessing external API: ${url} | Domain: ${isFinra ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov'} | CRD: ${id}`);
	const res = await fetch(url, fetchOptions);
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${url}`);
	}
	const payload = await res.json();
	if (!payload) return;

	const redisKey = `${source}:${type}:${id}`;
	const newJson = JSON.stringify(payload);

	// Save to Redis (TTL 24 hours)
	await setStringIfValid(redisKey, newJson, 60 * 60 * 24);
	console.log(`[Hydration Success] Time: ${new Date().toISOString()} | Saved to Redis | Domain: ${isFinra ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov'} | CRD: ${id} | Key: ${redisKey}`);

	// Save to local cache files if not on Vercel
	if (process.env.VERCEL !== '1') {
		try {
			const cacheDir = isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
			const cacheFileName = `api.${cacheDir}_search_${type}_${id}.json`;
			
			const nationalFile = path.join(process.cwd(), 'data', 'national', cacheDir, cacheFileName);
			const rawFile = path.join(process.cwd(), 'data', 'raw', cacheDir, cacheFileName);
			
			for (const f of [nationalFile, rawFile]) {
				await fs.mkdir(path.dirname(f), { recursive: true });
				await fs.writeFile(f, JSON.stringify(payload, null, 2), 'utf8');
			}
		} catch (err: any) {
			console.warn(`[Hydration] Failed to write local cache files: ${err.message}`);
		}
	}
}

async function processQueue() {
	if (isProcessing) return;
	isProcessing = true;

	while (hydrationQueue.length > 0) {
		const task = hydrationQueue.shift();
		if (!task) continue;

		const key = `${task.type}:${task.id}`;
		const now = Date.now();
		const lastTime = lastHydrated.get(key) || 0;
		if (now - lastTime < HYDRATION_COOLDOWN_MS) {
			continue;
		}

		lastHydrated.set(key, now);

		try {
			// Meter requests: wait 5 to 10 seconds before hitting external API
			const sleepTime = 5000 + Math.random() * 5000;
			await delay(sleepTime);

			// Check external API for both FINRA and SEC sources to keep both cache keys updated
			await Promise.allSettled([
				fetchAndSave('finra', task.type, task.id),
				fetchAndSave('sec', task.type, task.id)
			]);
		} catch (error: any) {
			console.error(`[Hydration] Error during background check for ${task.type} ${task.id}:`, error.message);
		}
	}

	isProcessing = false;
}

export function queueHydration(type: 'individual' | 'firm', id: string) {
	const alreadyInQueue = hydrationQueue.some((item) => item.type === type && item.id === id);
	if (alreadyInQueue) return;

	const key = `${type}:${id}`;
	const now = Date.now();
	const lastTime = lastHydrated.get(key) || 0;
	if (now - lastTime < HYDRATION_COOLDOWN_MS) {
		return;
	}

	hydrationQueue.push({ type, id });
	processQueue().catch((err) => {
		console.error('[Hydration] processQueue failed:', err);
	});
}
