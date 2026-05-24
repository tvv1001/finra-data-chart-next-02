import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import path from 'node:path';

const STATUS_SCRIPT = path.join(process.cwd(), 'scripts', 'daily_status_check.js');
const REVALIDATE_SCRIPT = path.join(process.cwd(), 'scripts', 'revalidate_external_presence.js');

async function runScript(scriptPath: string, args: string[] = []) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		const out: string[] = [];
		const err: string[] = [];
		const child = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env }, cwd: process.cwd() });

		child.stdout.on('data', (d) => out.push(String(d)));
		child.stderr.on('data', (d) => err.push(String(d)));

		child.on('error', (e) => reject(e));
		child.on('close', (code) => resolve({ code: Number(code ?? 0), stdout: out.join(''), stderr: err.join('') }));
	});
}

export async function POST(req: NextRequest) {
	const secret = process.env.FINRA_MAINT_CRON_SECRET || '';
	const header = req.headers.get('x-cron-secret') || '';
	if (!secret || header !== secret) {
		return new NextResponse(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
	}

	try {
		const statusResult = await runScript(STATUS_SCRIPT, ['--apply']);
		const revalidateResult = await runScript(REVALIDATE_SCRIPT, []);

		// try to pick most recent reports from data/national (best-effort)
		const DATA_DIR = path.join(process.cwd(), 'data', 'national');
		const files = await import('fs/promises');
		const entries = await files.readdir(DATA_DIR).catch(() => []);

		const pickLatest = async (prefix: string, suffix = '.json') => {
			const list = (entries || []).filter((f) => f.startsWith(prefix) && f.endsWith(suffix));
			if (!list || list.length === 0) return null;
			const stats = await Promise.all(list.map(async (name) => ({ name, stat: await files.stat(path.join(DATA_DIR, name)) })));
			stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
			return path.join(DATA_DIR, stats[0].name);
		};

		const validationReportPath = await pickLatest('external_link_validation_');
		const revalidateReportPath = await pickLatest('revalidate_report_');

		const validationReport = validationReportPath ? JSON.parse(await files.readFile(validationReportPath, 'utf8')) : null;
		const revalidateReport = revalidateReportPath ? JSON.parse(await files.readFile(revalidateReportPath, 'utf8')) : null;

		return NextResponse.json({
			ok: true,
			statusScript: statusResult,
			revalidateScript: revalidateResult,
			validationReport,
			revalidateReport,
		});
	} catch (e: any) {
		return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
	}
}

export async function GET() {
	return new NextResponse('POST only', { status: 405 });
}
