import { NextRequest, NextResponse } from 'next/server';
import { fileCacheGet, fileCacheSet } from '@/lib/file-cache';

export async function POST(req: NextRequest) {
	const url = new URL(req.url);
	const key = url.searchParams.get('key');
	const ttlParam = url.searchParams.get('ttl');
	const ttl = ttlParam ? parseInt(ttlParam, 10) : undefined;

	if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });

	try {
		const buf = Buffer.from(await req.arrayBuffer());
		await fileCacheSet(key, buf, ttl);
		return NextResponse.json({ ok: true });
	} catch (err) {
		console.error('local-cache POST error', err);
		return NextResponse.json({ error: 'failed to store' }, { status: 500 });
	}
}

export async function GET(req: NextRequest) {
	const url = new URL(req.url);
	const key = url.searchParams.get('key');
	if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });

	try {
		const val = await fileCacheGet(key);
		if (val === null) return NextResponse.json({ error: 'not found' }, { status: 404 });

		if (Buffer.isBuffer(val)) {
			return new NextResponse(val, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
		}

		return NextResponse.json({ data: val });
	} catch (err) {
		console.error('local-cache GET error', err);
		return NextResponse.json({ error: 'failed to read' }, { status: 500 });
	}
}
