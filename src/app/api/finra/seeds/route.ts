import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { SEEDS_FILE, SEED_PROFILES_FILE } from "@/lib/constants";
import {
  getSeedsCache, setSeedsCache,
  getProfilesCache, setProfilesCache,
} from "@/lib/graphStore";

async function getSeedsBase(): Promise<string[]> {
  const cached = getSeedsCache();
  if (cached) return cached;
  try {
    const data = JSON.parse(await readFile(SEEDS_FILE, "utf-8"));
    setSeedsCache(data);
    return data;
  } catch {
    return [];
  }
}

async function getProfilesData() {
  const cached = getProfilesCache();
  if (cached) return cached;
  try {
    const data = JSON.parse(await readFile(SEED_PROFILES_FILE, "utf-8"));
    setProfilesCache(data);
    return data;
  } catch {
    return { profiles: [] };
  }
}

export async function GET(request: NextRequest) {
  const profileName = new URL(request.url).searchParams.get("profile");
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
  if (!Array.isArray(seeds) || seeds.some((s) => typeof s !== "string")) {
    return NextResponse.json(
      { error: "Body must be { seeds: string[] }" },
      { status: 400 },
    );
  }
  await writeFile(SEEDS_FILE, JSON.stringify(seeds, null, 2), "utf-8");
  setSeedsCache(null as any);
  return NextResponse.json({ ok: true, count: seeds.length });
}
