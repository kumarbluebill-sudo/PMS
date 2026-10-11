import { NextResponse, type NextRequest } from "next/server";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { DISPLAY_STATUSES, STATUS_META, type DisplayStatus } from "@/server/domain/roomStatus";
import { getCtx } from "@/server/session";
import { roomBoard } from "@/server/services/dashboard";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** CSV cell: quoted, and neutralised against spreadsheet formula injection. */
const cell = (v: string | number | null | undefined) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
};

export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "reports.export", ctx.extra)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const p = req.nextUrl.searchParams;
  const get = (k: string) => p.get(k) || undefined;
  const status = get("status");
  const floor = get("floor");
  const board = await roomBoard(getDb(), ctx, {
    date: get("date") && DAY.test(get("date")!) ? get("date") : undefined,
    floor: floor && /^-?\d{1,3}$/.test(floor) ? Number(floor) : undefined,
    roomTypeId: get("type") && /^[0-9a-f-]{36}$/i.test(get("type")!) ? get("type") : undefined,
    status: status && (DISPLAY_STATUSES as readonly string[]).includes(status) ? (status as DisplayStatus) : undefined,
    q: get("q")?.slice(0, 80),
    arrival: get("arrival") && DAY.test(get("arrival")!) ? get("arrival") : undefined,
    checkout: get("checkout") && DAY.test(get("checkout")!) ? get("checkout") : undefined,
    sort: get("sort") === "checkout" || get("sort") === "status" ? (get("sort") as "checkout" | "status") : "number",
  });
  const canMoney = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  const header = ["Room", "Type", "Floor", "Status", "Housekeeping", "Guest", "Booking", "Check-in", "Checkout", "Payment", "Balance (INR)", "Reason"];
  const lines = [header.map(cell).join(",")];
  for (const r of board.rows) {
    lines.push(
      [
        r.number, r.roomType, r.floor, STATUS_META[r.status].label, r.housekeeping,
        r.stay?.guest, r.stay?.reference, r.stay?.arrival, r.stay?.departure,
        canMoney ? r.paymentStatus : "", canMoney && r.balanceMinor !== null ? (r.balanceMinor / 100).toFixed(2) : "", r.reason,
      ].map(cell).join(","),
    );
  }
  return new NextResponse(lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="room-board-${board.date}.csv"`,
      "cache-control": "no-store",
    },
  });
}
