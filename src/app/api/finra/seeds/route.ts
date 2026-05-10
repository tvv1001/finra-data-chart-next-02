import { NextRequest, NextResponse } from 'next/server';
import { getSeedsFromStore, saveSeedsToStore, getProfilesFromStore, getSeedBankFromStore } from '@/lib/graphStore';

async function getSeedsBase(): Promise<string[]> {
	return getSeedsFromStore();
}

async function getProfilesData() {
	return getProfilesFromStore();
}

export async function GET(request: NextRequest) {
	const searchParams = new URL(request.url).searchParams;
	if (searchParams.get('bank') === '1') {
		const seedBank = await getSeedBankFromStore();
		const { nameByNumber: _privateNameByNumber, ...publicSeedBank } = seedBank;
		return NextResponse.json(publicSeedBank);
	}

	const profileName = searchParams.get('profile');
	let base = await getSeedsBase();

	if (profileName) {
		const pr = await getProfilesData();
		if (Array.isArray(pr.profiles)) {
			const prof = pr.profiles.find((p: any) => p.name === profileName);
			if (prof) {
				const extras: string[] = [];
				if (Array.isArray(prof.seeds)) extras.push(...prof.seeds.filter(Boolean));
				if (Array.isArray(prof.individuals)) extras.push(...prof.individuals.map(String));
				if (Array.isArray(prof.firms)) extras.push(...prof.firms.map(String));
				base = [...extras, ...base];
			}
		}
	}

	return NextResponse.json(base);
}

export async function PUT(request: NextRequest) {
	const body = await request.json();
	const { seeds } = body;
	if (!Array.isArray(seeds) || seeds.some((s) => typeof s !== 'string')) {
		return NextResponse.json({ error: 'Body must be { seeds: string[] }' }, { status: 400 });
	}
	await saveSeedsToStore(seeds);
	return NextResponse.json({ ok: true, count: seeds.length });
}
