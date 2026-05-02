import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { SEED_PROFILES_FILE } from "@/lib/constants";
import { getProfilesCache, setProfilesCache, invalidateProfilesCache } from "@/lib/graphStore";

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const pr = await getProfilesData();
  if (!Array.isArray(pr.profiles)) {
    return NextResponse.json({ error: "No profiles defined" }, { status: 404 });
  }
  const prof = pr.profiles.find((p: any) => p.name === name);
  if (!prof) {
    return NextResponse.json(
      { error: `Profile '${name}' not found` },
      { status: 404 },
    );
  }
  return NextResponse.json({
    name: prof.name,
    description: prof.description || "",
    seeds: Array.isArray(prof.seeds) ? prof.seeds : [],
    individuals: Array.isArray(prof.individuals)
      ? prof.individuals.map(Number).filter(Boolean)
      : [],
    firms: Array.isArray(prof.firms)
      ? prof.firms.map(Number).filter(Boolean)
      : [],
  });
}
