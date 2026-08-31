import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/lib/logger';

export type PerformanceLogEntry = {
	label: string;
	durationMs?: number;
	memoryUsedMb?: number;
	heapUsedMb?: number;
	rssMb?: number;
	status?: 'ok' | 'error';
	meta?: Record<string, unknown>;
	phase?: 'start' | 'end';
	at: string;
};

function getMemorySnapshot() {
	if (typeof process === 'undefined' || !process.memoryUsage) {
		return null;
	}
	const usage = process.memoryUsage();
	return {
		heapUsedMb: Number((usage.heapUsed / 1024 / 1024).toFixed(2)),
		rssMb: Number((usage.rss / 1024 / 1024).toFixed(2)),
	};
}

function getPerformanceLogPath() {
	if (typeof process === 'undefined' || !process.cwd) return null;
	return path.join(process.cwd(), 'data', 'logs', 'performance.jsonl');
}

export async function readPerformanceLogEntries(limit = 250): Promise<PerformanceLogEntry[]> {
	const logPath = getPerformanceLogPath();
	if (!logPath) return [];
	try {
		const raw = await fs.readFile(logPath, 'utf8');
		const lines = raw
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(-limit);
		return lines
			.map((line) => {
				try {
					return JSON.parse(line) as PerformanceLogEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is PerformanceLogEntry => Boolean(entry));
	} catch {
		return [];
	}
}

export async function writePerformanceMetric(entry: Omit<PerformanceLogEntry, 'at'> & { at?: string }) {
	const logPath = getPerformanceLogPath();
	const memory = getMemorySnapshot();
	const payload: PerformanceLogEntry = {
		at: entry.at || new Date().toISOString(),
		label: entry.label,
		durationMs: entry.durationMs,
		memoryUsedMb: entry.memoryUsedMb ?? memory?.heapUsedMb,
		heapUsedMb: entry.heapUsedMb ?? memory?.heapUsedMb,
		rssMb: entry.rssMb ?? memory?.rssMb,
		status: entry.status,
		phase: entry.phase,
		meta: entry.meta,
	};

	if (logPath) {
		try {
			await fs.mkdir(path.dirname(logPath), { recursive: true });
			await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
		} catch (error) {
			logger.warn('performance analytics write failed', {
				label: payload.label,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	logger.info('performance', payload);
}

export async function measurePerformance<T>(label: string, work: () => Promise<T> | T, meta: Record<string, unknown> = {}): Promise<T> {
	const startedAt = Date.now();
	const memoryBefore = getMemorySnapshot();
	try {
		const result = await work();
		const durationMs = Date.now() - startedAt;
		const memoryAfter = getMemorySnapshot();
		await writePerformanceMetric({
			label,
			durationMs,
			memoryUsedMb: memoryAfter?.heapUsedMb,
			heapUsedMb: memoryAfter?.heapUsedMb,
			rssMb: memoryAfter?.rssMb,
			status: 'ok',
			phase: 'end',
			meta: {
				...meta,
				memoryBeforeMb: memoryBefore?.heapUsedMb,
				memoryDeltaMb: memoryAfter && memoryBefore ? Number((memoryAfter.heapUsedMb - memoryBefore.heapUsedMb).toFixed(2)) : undefined,
			},
		});
		return result;
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const memoryAfter = getMemorySnapshot();
		await writePerformanceMetric({
			label,
			durationMs,
			memoryUsedMb: memoryAfter?.heapUsedMb,
			heapUsedMb: memoryAfter?.heapUsedMb,
			rssMb: memoryAfter?.rssMb,
			status: 'error',
			phase: 'end',
			meta: {
				...meta,
				error: error instanceof Error ? error.message : String(error),
				memoryBeforeMb: memoryBefore?.heapUsedMb,
				memoryDeltaMb: memoryAfter && memoryBefore ? Number((memoryAfter.heapUsedMb - memoryBefore.heapUsedMb).toFixed(2)) : undefined,
			},
		});
		throw error;
	}
}
