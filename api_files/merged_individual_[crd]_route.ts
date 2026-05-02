import { NextRequest, NextResponse } from "next/server";
import { mergedIndividual } from "@/lib/dataMerge";
import { logger } from "@/lib/logger";

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
      return NextResponse.json({ error: "Merged record not found" }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (err: any) {
    logger.error("merged individual error", { crd, error: err?.message });
    return NextResponse.json({ error: "Failed to compute merged record" }, { status: 500 });
  }
}
