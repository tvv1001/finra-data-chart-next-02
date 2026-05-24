import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'validate_external_links.js');

export async function POST(req: NextRequest) {
	const secret = process.env.VALIDATE_CRON_SECRET || '';
	const header = req.headers.get('x-cron-secret') || '';
	if (!secret || header !== secret) {
		return new NextResponse(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
	}

	if (!SCRIPT_PATH) {
		return NextResponse.json({ ok: false, error: 'validator-not-configured' }, { status: 500 });
	}

	try {
		const out: string[] = [];
		const err: string[] = [];
		// run with --apply so the script writes suggested changes file (non-destructive)
		const child = spawn(process.execPath, [SCRIPT_PATH, '--apply'], { env: { ...process.env }, cwd: process.cwd() });

		child.stdout.on('data', (d) => out.push(String(d)));
		child.stderr.on('data', (d) => err.push(String(d)));

		const code: number = await new Promise((resolve, reject) => {
			child.on('close', resolve);
			child.on('error', reject);
		});

		const stdout = out.join('');
		const stderr = err.join('');

		// After validation completes, also run the revalidate_external_presence script
		const REVALIDATE_PATH = path.join(process.cwd(), 'scripts', 'revalidate_external_presence.js');
		let revalidate = null;
		try {
			const rout: string[] = [];
			const rerr: string[] = [];
			// build safe args to limit concurrency/work per-run to stay within free tier limits
			const rvConcurrency = process.env.REVALIDATE_CONCURRENCY || '1';
			const rvLimit = process.env.REVALIDATE_LIMIT || '200';
			const rchild = spawn(process.execPath, [REVALIDATE_PATH, `--concurrency=${rvConcurrency}`, `--limit=${rvLimit}`], { env: { ...process.env }, cwd: process.cwd() });
			rchild.stdout.on('data', (d) => rout.push(String(d)));
			rchild.stderr.on('data', (d) => rerr.push(String(d)));

			const rcode: number = await new Promise((resolve, reject) => {
				rchild.on('close', resolve);
				rchild.on('error', reject);
			});

			revalidate = { exitCode: Number(rcode ?? 0), stdout: rout.join(''), stderr: rerr.join('') };
		} catch (re) {
			revalidate = { error: String(re) };
		}

		// locate the most recent report and suggested files in data/national
		const DATA_DIR = path.join(process.cwd(), 'data', 'national');
		const files = await import('fs/promises');
		const entries = await files.readdir(DATA_DIR);
		const reportFiles = entries.filter((f) => f.startsWith('external_link_validation_') && f.endsWith('.json'));
		const suggestedFiles = entries.filter((f) => f.startsWith('external_link_suggested_changes_') && f.endsWith('.json'));

		const pickLatest = async (list) => {
			if (!list || list.length === 0) return null;
			const stats = await Promise.all(list.map(async (name) => ({ name, stat: await files.stat(path.join(DATA_DIR, name)) })));
			stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
			return path.join(DATA_DIR, stats[0].name);
		};

		const latestReport = await pickLatest(reportFiles);
		const latestSuggested = await pickLatest(suggestedFiles);

		const reportJson = latestReport ? JSON.parse(await files.readFile(latestReport, 'utf8')) : null;
		const suggestedJson = latestSuggested ? JSON.parse(await files.readFile(latestSuggested, 'utf8')) : null;

		return NextResponse.json({ ok: true, exitCode: code, report: reportJson, suggested: suggestedJson, stdout, stderr, revalidate });
	} catch (e: any) {
		return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
	}
}

export async function GET() {
	return new NextResponse('POST only', { status: 405 });
}
