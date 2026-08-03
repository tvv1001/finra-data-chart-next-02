import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const HISTORY_DIR = path.join(process.cwd(), 'data', 'local');
const HISTORY_FILE = path.join(HISTORY_DIR, 'finra_dashboard_history.json');

async function ensureDir() {
	try {
		await fs.mkdir(HISTORY_DIR, { recursive: true });
	} catch (e) {
		// ignore
	}
}

export async function GET() {
	try {
		const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
		const data = JSON.parse(raw || '[]');
		return NextResponse.json({ ok: true, data });
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
	}
}

export async function POST(request: Request) {
	try {
		const body = await request.json();
		if (!Array.isArray(body)) return NextResponse.json({ ok: false, error: 'Invalid payload' }, { status: 400 });
		await ensureDir();
		await fs.writeFile(HISTORY_FILE, JSON.stringify(body, null, 2), 'utf-8');
		return NextResponse.json({ ok: true });
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}

export async function DELETE() {
	try {
		await fs.unlink(HISTORY_FILE);
		return NextResponse.json({ ok: true });
	} catch (err: any) {
		// If file doesn't exist, still return ok
		return NextResponse.json({ ok: true });
	}
}
