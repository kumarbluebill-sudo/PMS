import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { runSubscriptionJob } from "@/server/services/platform";

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
 * Daily subscription job: renewal invoices, reminders, and the move from payment due to past due, suspended and
 * expired. Only runs with the shared secret; without CRON_SECRET it does nothing. Safe to run more than once a day.
 */
export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "Not configured" }, { status: 404, headers });
  if (!authorised(req)) return NextResponse.json({ error: "Unauthorised" }, { status: 401, headers });
  const result = await runSubscriptionJob(getDb());
  return NextResponse.json({ ok: true, ...result }, { headers });
}
