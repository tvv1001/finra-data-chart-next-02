import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";
import { DEFAULT_HEADERS } from "@/lib/constants";
import { sharedCacheHeaders } from "@/lib/httpCache";
import { logger } from "@/lib/logger";

function parseDetailPayload(data: any, contentKey = "content") {
  if (!data) return null;
  if (data?.hits?.hits?.length) {
    const raw = data.hits.hits[0]?._source?.[contentKey];
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw || null;
    } catch {
      return null;
    }
  }

  const raw = data?.[contentKey];
  if (raw != null) {
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw || null;
    } catch {
      return null;
    }
  }

  if (isPlainObject(data)) {
    const looksLikeDetail =
      data.basicInformation ||
      data.individualId ||
      data.firstName ||
      data.lastName ||
      data.bcScope ||
      data.iaScope ||
      data.disclosures ||
      data.currentEmployments ||
      data.previousEmployments;
    if (looksLikeDetail) return data;
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mergePreferPrimary(primary: unknown, secondary: unknown): unknown {
  if (primary == null || primary === "") return secondary;
  if (secondary == null || secondary === "") return primary;
  if (Array.isArray(primary) && Array.isArray(secondary)) {
    if (!primary.length) return secondary;
    if (!secondary.length) return primary;
    const seen = new Set(primary.map((item) => JSON.stringify(item)));
    return [
      ...primary,
      ...secondary.filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ];
  }
  if (isPlainObject(primary) && isPlainObject(secondary)) {
    const merged: Record<string, unknown> = { ...primary };
    for (const [key, value] of Object.entries(secondary)) {
      merged[key] = key in merged ? mergePreferPrimary(merged[key], value) : value;
    }
    return merged;
  }
  return primary;
}

function buildIndividualQueryParams(searchParams: URLSearchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    if (!value) continue;
    params.set(key, value);
  }
  if (!params.has("hl")) params.set("hl", "true");
  if (!params.has("wt")) params.set("wt", "json");
  if (!params.has("nrows")) params.set("nrows", "12");
  if (!params.has("includePrevious")) params.set("includePrevious", "true");
  return params;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ crd: string }> },
) {
  const { crd } = await params;
  if (!/^\d{1,10}$/.test(crd)) {
    return NextResponse.json({ error: "Invalid CRD number." }, { status: 400 });
  }

  try {
    const { default: axios } = await import("axios");
    const params = buildIndividualQueryParams(new URL(request.url).searchParams);
    const queryString = params.toString();

    const [finraData, secData] = await Promise.all([
      cachedFetch(`finra:individual:${crd}:${queryString}`, 60 * 60 * 24 * 7, async () => {
        const finraUrl = queryString
          ? `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${queryString}`
          : `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}`;
        const r = await axios.get(finraUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
        return r.data;
      }),
      cachedFetch(`sec:individual:${crd}`, 60 * 60 * 24 * 7, async () => {
        try {
          const r = await axios.get(
            `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?wt=json`,
            { headers: DEFAULT_HEADERS, timeout: 15000 },
          );
          return r.data;
        } catch {
          return null;
        }
      }),
    ]);

    const finraDetail = parseDetailPayload(finraData, "content");
    if (!finraDetail) {
      return NextResponse.json(
        { found: false },
        { status: 200, headers: sharedCacheHeaders(3600) },
      );
    }

    const secDetail = parseDetailPayload(secData, "iacontent");
    const detail: any = secDetail ? mergePreferPrimary(secDetail, finraDetail) : finraDetail;
    detail.hasSecData = !!secDetail;

    return NextResponse.json(detail, { headers: sharedCacheHeaders(3600) });
  } catch (err: any) {
    logger.error("individual proxy error", { crd, error: err.message });
    return NextResponse.json({ error: "Failed to fetch from FINRA." }, { status: 502 });
  }
}
