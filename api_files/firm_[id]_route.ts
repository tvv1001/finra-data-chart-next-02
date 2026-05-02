import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";
import { DEFAULT_HEADERS } from "@/lib/constants";
import { logger } from "@/lib/logger";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) {
    return NextResponse.json({ error: "Invalid firm ID." }, { status: 400 });
  }

  try {
    const { default: axios } = await import("axios");

    const bcUrl = `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}`;
    const secUrl = `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`;

    const [bcData, secData] = await Promise.allSettled([
      cachedFetch(`finra:firm:${id}`, 60 * 60 * 24 * 7, async () => {
        const r = await axios.get(bcUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
        return r.data;
      }),
      cachedFetch(`sec:firm:${id}`, 60 * 60 * 24 * 7, async () => {
        const r = await axios.get(secUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
        return r.data;
      }),
    ]);

    let bcDetail: any = null;
    if (bcData.status === "fulfilled") {
      const data = bcData.value;
      if (data?.hits?.hits?.length) {
        const raw = data.hits.hits[0]?._source?.content;
        bcDetail = typeof raw === "string" ? JSON.parse(raw) : raw;
      } else if (data?.content) {
        bcDetail = typeof data.content === "string" ? JSON.parse(data.content) : data.content;
      }
    }

    let secDetail: any = null;
    if (secData.status === "fulfilled") {
      const data = secData.value;
      if (data?.hits?.hits?.length) {
        const raw = data.hits.hits[0]?._source?.iacontent;
        secDetail = typeof raw === "string" ? JSON.parse(raw) : raw;
      }
    }

    if (!bcDetail && !secDetail) {
      return NextResponse.json({ error: "Firm not found." }, { status: 404 });
    }

    let detail: any = bcDetail || secDetail;
    if (secDetail) {
      const sbi = secDetail.basicInformation || {};
      const dbi = detail.basicInformation || {};
      const mergeField = (key: string) => {
        if (!dbi[key] && sbi[key]) dbi[key] = sbi[key];
      };
      ["firmStatus","firmStatusDate","firmType","firmSize","regulator","formedState",
       "formedDate","districtName","isLegacy","iaSECNumber","bdSECNumber","bcScope",
       "iaScope","fiscalMonthEndCode"].forEach(mergeField);
      if ((!dbi.otherNames || !dbi.otherNames.length) && sbi.otherNames?.length)
        dbi.otherNames = sbi.otherNames;
      detail.basicInformation = dbi;

      if (!detail.firmAddressDetails && secDetail.firmAddressDetails) detail.firmAddressDetails = secDetail.firmAddressDetails;
      if (!detail.iaFirmAddressDetails && secDetail.iaFirmAddressDetails) detail.iaFirmAddressDetails = secDetail.iaFirmAddressDetails;
      if (!detail.registrations && secDetail.registrations) detail.registrations = secDetail.registrations;
      if (!detail.registrationStatus && secDetail.registrationStatus) detail.registrationStatus = secDetail.registrationStatus;
      if (!detail.noticeFilings && secDetail.noticeFilings) detail.noticeFilings = secDetail.noticeFilings;
      if (!detail.directOwners?.length && secDetail.directOwners?.length) detail.directOwners = secDetail.directOwners;
      if (!detail.disclosures?.length && secDetail.disclosures?.length) detail.disclosures = secDetail.disclosures;
      if (!detail.brochures && secDetail.brochures) detail.brochures = secDetail.brochures;
    }

    return NextResponse.json(detail);
  } catch (err: any) {
    logger.error("firm proxy error", { id, error: err.message });
    return NextResponse.json({ error: "Failed to fetch from FINRA." }, { status: 502 });
  }
}
