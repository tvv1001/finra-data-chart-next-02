import { NextRequest, NextResponse } from "next/server";
import { mergedFirm } from "@/lib/dataMerge";
import { sharedCacheHeaders } from "@/lib/httpCache";
import { logger } from "@/lib/logger";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9]+$/.test(id)) {
    return NextResponse.json({ error: "Invalid firm id" }, { status: 400 });
  }
  try {
    const data = await mergedFirm(id);
    if (!data.found) {
      return NextResponse.json({ found: false }, { headers: sharedCacheHeaders(3600) });
    }
    return NextResponse.json(data, { headers: sharedCacheHeaders(3600) });
  } catch (err: any) {
    logger.error("merged firm error", { id, error: err?.message });
    return NextResponse.json({ error: "Failed to compute merged firm" }, { status: 500 });
  }
}
