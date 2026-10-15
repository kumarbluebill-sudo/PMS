import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { alertCounts } from "@/server/services/alerts";
import { unreadNotificationCount } from "@/server/services/notifications";
import { getCtx } from "@/server/session";

/** Lightweight count for the header bell. Never cached, always scoped to the signed-in user's property. */
export async function GET() {
  try {
    const ctx = await getCtx();
    const [c, unread] = await Promise.all([alertCounts(getDb(), ctx).catch(() => ({ critical: 0, warning: 0, total: 0 })), unreadNotificationCount(getDb(), ctx).catch(() => 0)]);
    return NextResponse.json({ ...c, notifications: unread, total: c.total + unread }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ critical: 0, warning: 0, total: 0 }, { status: 200, headers: { "cache-control": "private, no-store" } });
  }
}
