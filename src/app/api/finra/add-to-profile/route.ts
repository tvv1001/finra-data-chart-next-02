import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { SEED_PROFILES_FILE } from "@/lib/constants";
import { invalidateProfilesCache } from "@/lib/graphStore";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { profile, individuals, firms } = body;

  if (typeof profile !== "string") {
    return NextResponse.json({ error: "profile must be a string" }, { status: 400 });
  }
  if (individuals && !Array.isArray(individuals)) {
    return NextResponse.json({ error: "individuals must be an array" }, { status: 400 });
  }
  if (firms && !Array.isArray(firms)) {
    return NextResponse.json({ error: "firms must be an array" }, { status: 400 });
  }

  const profilesData = JSON.parse(await readFile(SEED_PROFILES_FILE, "utf-8"));
  const prof = profilesData.profiles.find((p: any) => p.name === profile);
  if (!prof) {
    return NextResponse.json(
      { error: `Profile '${profile}' not found` },
      { status: 404 },
    );
  }

  if (individuals) {
    prof.individuals = [...new Set([...(prof.individuals || []), ...individuals])];
  }
  if (firms) {
    prof.firms = [...new Set([...(prof.firms || []), ...firms])];
  }

  await writeFile(SEED_PROFILES_FILE, JSON.stringify(profilesData, null, 2), "utf-8");
  invalidateProfilesCache();

  return NextResponse.json({
    ok: true,
    added: {
      individuals: individuals?.length || 0,
      firms: firms?.length || 0,
    },
  });
}
