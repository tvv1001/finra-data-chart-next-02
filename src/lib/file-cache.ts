/**
 * File-based local cache for development / localhost usage.
 * Stores items under <project-root>/data/local-cache as JSON/meta and .bin for binary payloads.
 */
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'data', 'local-cache');

function safeFilename(key: string) {
	return Buffer.from(key).toString('base64').replace(/\//g, '_').replace(/\+/g, '-').replace(/=+$/, '');
}

function metaPath(filename: string) {
	return path.join(CACHE_DIR, `${filename}.meta.json`);
}

function jsonPath(filename: string) {
	return path.join(CACHE_DIR, `${filename}.json`);
}

function binPath(filename: string) {
	return path.join(CACHE_DIR, `${filename}.bin`);
}

export async function fileCacheSet(key: string, value: any, ttlMs?: number) {
	await fs.promises.mkdir(CACHE_DIR, { recursive: true });
	const filename = safeFilename(key);
	const timestamp = Date.now();
	const meta = { timestamp, ttl: typeof ttlMs === 'number' ? ttlMs : null } as any;

	if (Buffer.isBuffer(value)) {
		await fs.promises.writeFile(binPath(filename), value);
		await fs.promises.writeFile(metaPath(filename), JSON.stringify({ ...meta, isBinary: true }));
		return;
	}

	// store JSON-serializable content
	try {
		await fs.promises.writeFile(jsonPath(filename), JSON.stringify(value));
		await fs.promises.writeFile(metaPath(filename), JSON.stringify({ ...meta, isBinary: false }));
	} catch (err) {
		// fallback to string
		await fs.promises.writeFile(jsonPath(filename), String(value));
		await fs.promises.writeFile(metaPath(filename), JSON.stringify({ ...meta, isBinary: false }));
	}
}

export async function fileCacheGet<T = any>(key: string): Promise<T | Buffer | null> {
	const filename = safeFilename(key);
	const mPath = metaPath(filename);
	try {
		const metaRaw = await fs.promises.readFile(mPath, 'utf-8');
		const meta = JSON.parse(metaRaw) as { timestamp: number; ttl: number | null; isBinary?: boolean };
		if (meta.ttl && Date.now() - meta.timestamp > meta.ttl) {
			// expired
			try {
				await fs.promises.unlink(mPath);
			} catch {}
			try {
				await fs.promises.unlink(jsonPath(filename));
			} catch {}
			try {
				await fs.promises.unlink(binPath(filename));
			} catch {}
			return null;
		}

		if (meta.isBinary) {
			const buf = await fs.promises.readFile(binPath(filename));
			return buf;
		}

		const raw = await fs.promises.readFile(jsonPath(filename), 'utf-8');
		try {
			return JSON.parse(raw) as T;
		} catch (err) {
			return raw as unknown as T;
		}
	} catch (err) {
		return null;
	}
}

export async function fileCacheHas(key: string): Promise<boolean> {
	const val = await fileCacheGet(key);
	return val !== null;
}

export function fileCacheClearSync() {
	try {
		if (fs.existsSync(CACHE_DIR)) {
			// remove directory synchronously so callers that expect sync behavior don't need to await
			fs.rmSync(CACHE_DIR, { recursive: true, force: true });
		}
	} catch (err) {
		console.warn('fileCacheClearSync error', err);
	}
}
