import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { getCtx } from "@/server/session";
import { guestHistory } from "@/server/services/guests";

const headers = { "cache-control": "private, no-store" };

/** A guest's previous stays at this property, for the history panel. Outstanding balance only for staff with billing access. */
export async function GET(_req: NextRequest, { params }: RouteContext<"/api/guests/[id]/history">) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await getCtx();
  } catch {
    return NextResponse.json({ error: "Sign in again." }, { status: 401, headers });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Guest not found." }, { status: 404, headers });
  try {
    return NextResponse.json(await guestHistory(getDb(), ctx, id), { headers });
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") return NextResponse.json({ error: "Guest not found." }, { status: 404, headers });
    if (e instanceof AppError && (e.code === "FORBIDDEN" || e.code === "UNAUTHENTICATED")) return NextResponse.json({ error: "You do not have access to guest records." }, { status: 403, headers });
    return NextResponse.json({ error: "Guest history is not available right now." }, { status: 500, headers });
  }
}
