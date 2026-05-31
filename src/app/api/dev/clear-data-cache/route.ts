import { NextRequest, NextResponse } from 'next/server';
import { clearDataMergeCache } from '@/lib/dataMerge';

export async function POST(_request: NextRequest) {
	try {
		clearDataMergeCache();
		return NextResponse.json({ ok: true, message: 'dataMerge cache cleared' });
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}

export async function GET() {
	// allow GET during dev for convenience
	try {
		clearDataMergeCache();
		return NextResponse.json({ ok: true, message: 'dataMerge cache cleared' });
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}
