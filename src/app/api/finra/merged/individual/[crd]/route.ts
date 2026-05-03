import { NextRequest, NextResponse } from "next/server";
import { mergedIndividual } from "@/lib/dataMerge";
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

function normalizeMergedIndividualDetail(detail: any, crd: string) {
  if (!detail || typeof detail !== "object") return detail;
  if (!detail.basicInformation) {
    const bi: any = {};
    if (detail.individualId || detail.ind_source_id || detail.crd || crd) {
      bi.individualId = detail.individualId || detail.ind_source_id || detail.crd || crd;
    }
    if (detail.firstName) bi.firstName = detail.firstName;
    if (detail.middleName) bi.middleName = detail.middleName;
    if (detail.lastName) bi.lastName = detail.lastName;
    if (detail.name) bi.name = detail.name;
    if (detail.bcScope) bi.bcScope = detail.bcScope;
    if (detail.iaScope) bi.iaScope = detail.iaScope;
    if (detail.otherNames) bi.otherNames = detail.otherNames;
    if (Object.keys(bi).length) {
      detail.basicInformation = bi;
    }
  }
  return detail;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ crd: string }> },
) {
  const { crd } = await params;
  if (!/^[0-9]+$/.test(crd)) {
    return NextResponse.json({ error: "Invalid CRD" }, { status: 400 });
  }
  try {
    const data = await mergedIndividual(crd);
    if (!data.found) {
      return NextResponse.json({ found: false }, { headers: sharedCacheHeaders(3600) });
    }

    const finraDetail = parseDetailPayload(data.sources.finra || {}, "content");
    const secDetail = parseDetailPayload(data.sources.sec || {}, "iacontent");
    const mergedDetail = secDetail
      ? mergePreferPrimary(secDetail, finraDetail)
      : finraDetail;
    const normalizedMergedDetail = normalizeMergedIndividualDetail(mergedDetail, crd);

    return NextResponse.json({
      ...data,
      merged: normalizedMergedDetail,
    }, { headers: sharedCacheHeaders(3600) });
  } catch (err: any) {
    logger.error("merged individual error", { crd, error: err?.message });
    return NextResponse.json({ error: "Failed to compute merged record" }, { status: 500 });
  }
}
