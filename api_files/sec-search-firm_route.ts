import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";
import { DEFAULT_HEADERS } from "@/lib/constants";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("query") || searchParams.get("q") || "";
    if (!q) return NextResponse.json({ hits: { hits: [] } });

    const { default: axios } = await import("axios");
    const url = `https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(q)}&hl=true&nrows=12&start=0&wt=json`;
    const data = await cachedFetch(`sec:firm-search:${q}`, 600, async () => {
      const r = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 15000 });
      return r.data;
    });
    return NextResponse.json(data);
  } catch (err: any) {
    logger.error("sec-search-firm error", { error: err.message });
    return NextResponse.json({ error: "Failed to search SEC firms." }, { status: 502 });
  }
}
