import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rateLimit";
import { getCtx } from "@/server/session";
import { lookupGuests } from "@/server/services/guests";

const headers = { "cache-control": "private, no-store" };

/** Live guest lookup for the reservation form. Needs a signed-in user with guest access; never cached. */
export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await getCtx();
  } catch {
    return NextResponse.json({ error: "Sign in again to search guests." }, { status: 401, headers });
  }
  if (!rateLimit(`guest-lookup:${ctx.userId}`, 120, 60_000)) {
    return NextResponse.json({ error: "Too many searches. Wait a moment and try again." }, { status: 429, headers });
  }
  try {
    const results = await lookupGuests(getDb(), ctx, req.nextUrl.searchParams.get("q") ?? "");
    return NextResponse.json({ results }, { headers });
  } catch (e) {
    if (e instanceof AppError && (e.code === "FORBIDDEN" || e.code === "UNAUTHENTICATED")) {
      return NextResponse.json({ error: "You do not have access to guest records." }, { status: 403, headers });
    }
    return NextResponse.json({ error: "Guest search is not available right now." }, { status: 500, headers });
  }
}
