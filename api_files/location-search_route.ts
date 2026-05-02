import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";
import { DEFAULT_HEADERS } from "@/lib/constants";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const state = searchParams.get("state") || "";
    const city = searchParams.get("city") || "";
    const type = searchParams.get("type") || "individual";
    if (!state) return NextResponse.json({ error: "state is required" }, { status: 400 });

    const { default: axios } = await import("axios");
    const params = new URLSearchParams({ query: "*:*", hl: "true", nrows: "25", start: "0", wt: "json" });
    if (state) params.set("state", state.toUpperCase());
    if (city) params.set("city", city.toUpperCase());

    const url = `https://api.brokercheck.finra.org/search/${encodeURIComponent(type)}?${params}`;
    const cacheKey = `finra:location:${type}:${state}:${city}`;
    const data = await cachedFetch(cacheKey, 600, async () => {
      const r = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 15000 });
      return r.data;
    });
    return NextResponse.json(data);
  } catch (err: any) {
    logger.error("location-search error", { error: err.message });
    return NextResponse.json({ error: "Failed to perform location search." }, { status: 502 });
  }
}
