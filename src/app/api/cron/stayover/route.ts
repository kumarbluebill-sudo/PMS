import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { runStayoverForAllProperties } from "@/server/services/housekeepingTasks";

const headers = { "cache-control": "no-store" };

/** Constant-time check of the bearer token Vercel Cron sends when CRON_SECRET is set. */
function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Daily stayover job. Only runs with the shared secret; without CRON_SECRET configured it does nothing, so the URL is
 * useless to anyone else. Properties that have not switched on automatic stayover tasks are left alone.
 */
export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "Not configured" }, { status: 404, headers });
  if (!authorised(req)) return NextResponse.json({ error: "Unauthorised" }, { status: 401, headers });
  const result = await runStayoverForAllProperties(getDb());
  return NextResponse.json({ ok: true, ...result }, { headers });
}
