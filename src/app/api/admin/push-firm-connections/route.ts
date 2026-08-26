import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { setStringIfValid, getRedisClient } from "@/lib/redisCache";
import {
  firmConnectionsCacheKey,
  firmConnectionsVerifiedCacheKey,
} from "@/lib/graphConnections";

type PushResult = { firmId: string; ok: boolean; reason?: string };

async function auditLogEntry(req: NextRequest, entry: Record<string, any>) {
  try {
    // Push to Redis admin audit list (best-effort)
    const redis = getRedisClient();
    if (redis) {
      await redis
        .lpush("dashboard:admin-audit", JSON.stringify(entry))
        .catch(() => null);
      await redis.ltrim("dashboard:admin-audit", 0, 999).catch(() => null);
    }
    // Also append to local disk logfile for permanent audit trail
    try {
      const logDir = path.join(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const out = path.join(logDir, "admin-audit.log");
      const line =
        JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
      fs.appendFileSync(out, line, "utf8");
    } catch {}
  } catch {}
}

function allowedSecretMatches(req: NextRequest) {
  const expected =
    process.env.ADMIN_PUSH_SECRET || process.env.PUSH_SECRET || "";
  if (!expected) return false;
  const header =
    req.headers.get("x-admin-secret") || req.headers.get("authorization") || "";
  if (!header) return false;
  if (header.startsWith("Bearer ")) return header.slice(7) === expected;
  return header === expected;
}

export async function POST(req: NextRequest) {
  try {
    if (!allowedSecretMatches(req)) {
      // audit unauthorized attempt
      await auditLogEntry(req, {
        action: "push-firm-connections-attempt",
        ok: false,
        reason: "unauthorized",
        ua: req.headers.get("user-agent") || "",
        ip:
          req.headers.get("x-forwarded-for") ||
          req.headers.get("x-real-ip") ||
          "local",
      }).catch(() => null);
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const firmIds: string[] = [];
    if (typeof body?.firmId === "string" && body.firmId.trim())
      firmIds.push(String(body.firmId).trim());
    if (Array.isArray(body?.firmIds))
      for (const f of body.firmIds) if (f) firmIds.push(String(f).trim());
    if (!firmIds.length)
      return NextResponse.json(
        { ok: false, error: "no firmId(s) provided" },
        { status: 400 },
      );

    const results: PushResult[] = [];
    for (const firmId of firmIds) {
      try {
        const file = path.join(
          process.cwd(),
          "data",
          "firm-connections",
          `${firmId}.json`,
        );
        if (!fs.existsSync(file)) {
          results.push({ firmId, ok: false, reason: "file not found" });
          continue;
        }
        const raw = fs.readFileSync(file, "utf8");
        const cacheKey = firmConnectionsCacheKey(firmId);
        const emptyKey = `${cacheKey}:empty`;

        const res = await setStringIfValid(cacheKey, raw, 60 * 60 * 24 * 30);
        // remove empty sentinel and any stale "fully validated" fast-path flag (this
        // pushed snapshot hasn't necessarily been re-verified) if present
        try {
          const redis = getRedisClient();
          if (redis) {
            const v = await redis.get(emptyKey).catch(() => null);
            if (v != null) await redis.del(emptyKey).catch(() => null);
            await redis
              .del(firmConnectionsVerifiedCacheKey(firmId))
              .catch(() => null);
          }
        } catch {}

        if (res === "written") {
          results.push({ firmId, ok: true });
          await auditLogEntry(req, {
            action: "push-firm-connections",
            firmId,
            ok: true,
            method: "disk->redis",
            actor: req.headers.get("x-admin-secret") ? "admin" : "unknown",
            ua: req.headers.get("user-agent") || "",
            ip:
              req.headers.get("x-forwarded-for") ||
              req.headers.get("x-real-ip") ||
              "local",
          });
        } else {
          results.push({ firmId, ok: false, reason: String(res) });
          await auditLogEntry(req, {
            action: "push-firm-connections",
            firmId,
            ok: false,
            reason: String(res),
            method: "disk->redis",
            actor: req.headers.get("x-admin-secret") ? "admin" : "unknown",
            ua: req.headers.get("user-agent") || "",
            ip:
              req.headers.get("x-forwarded-for") ||
              req.headers.get("x-real-ip") ||
              "local",
          });
        }
      } catch (e: any) {
        results.push({ firmId, ok: false, reason: String(e?.message || e) });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  // Allow quick GET health check when authenticated with ?firmId=123
  try {
    if (!allowedSecretMatches(req))
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    const url = new URL(req.url);
    const firmId = url.searchParams.get("firmId") || undefined;
    if (!firmId)
      return NextResponse.json(
        { ok: false, error: "missing firmId query" },
        { status: 400 },
      );
    // proxy to POST behavior for single firm
    return await POST(
      new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify({ firmId }),
      }) as unknown as NextRequest,
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 },
    );
  }
}
