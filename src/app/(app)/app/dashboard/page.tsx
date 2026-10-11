import Link from "next/link";
import { roomStatusAction } from "@/app/actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, inr, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import type { Ctx } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { DISPLAY_STATUSES, STATUS_META, type DisplayStatus } from "@/server/domain/roomStatus";
import { getCtx } from "@/server/session";
import { roomBoard, type BoardRow } from "@/server/services/dashboard";
import { ReservationActions } from "../ReservationActions";
import { RoomStatusChip, RoomStatusLegend } from "../RoomStatusChip";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function RowActions({ row, ctx, back, date }: { row: BoardRow; ctx: Ctx; back: string; date: string }) {
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const s = row.stay;
  const live = s && s.kind !== "LAST";
  return (
    <div className="flex flex-wrap items-center gap-1">
      {s && can("reservations.view") && (
        <Link href={`/app/reservations/${s.reservationId}`} className={btnGhost}>
          {s.kind === "CURRENT" ? "View stay" : s.kind === "UPCOMING" ? "View booking" : "Last stay"}
        </Link>
      )}
      {live && s.reservationStatus && <ReservationActions id={s.reservationId} status={s.reservationStatus} ctx={ctx} back={back} only={["checkin", "checkout"]} />}
      {(row.status === "AVAILABLE" || row.status === "RESERVED") && can("reservations.create") && (
        <Link href={`/app/reservations?roomTypeId=${row.roomTypeId}&roomId=${row.roomId}&arrival=${date}`} className={btnGhost}>New booking</Link>
      )}
      {(row.status === "OUT_OF_ORDER" || row.status === "MAINTENANCE") && can("maintenance.manage") && (
        <Link href="/app/maintenance" className={btnGhost}>View reason</Link>
      )}
      {can("housekeeping.update") && (row.status === "AVAILABLE" || row.status === "RESERVED" || row.status === "CLEANING") && (
        <form action={roomStatusAction}>
          <input type="hidden" name="roomId" value={row.roomId} />
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="status" value={row.status === "CLEANING" ? "CLEAN" : "DIRTY"} />
          <button className={btnGhost}>{row.status === "CLEANING" ? "Mark clean" : "Mark for cleaning"}</button>
        </form>
      )}
      {can("maintenance.manage") && row.status !== "OUT_OF_ORDER" && (
        <Link href={`/app/maintenance?roomId=${row.roomId}`} className={btnGhost}>Report maintenance</Link>
      )}
    </div>
  );
}

function Checkout({ row, time }: { row: BoardRow; time: string }) {
  const s = row.stay;
  if (!s) return <>—</>;
  if (s.kind === "LAST") {
    return <>Out {s.actualCheckout ? new Date(s.actualCheckout).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : shortDate(s.departure)}</>;
  }
  return <>{shortDate(s.departure)}, {time}</>;
}

export default async function Dashboard({ searchParams }: PageProps<"/app/dashboard">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const rawDate = one(sp.date);
  const rawStatus = one(sp.status);
  const rawFloor = one(sp.floor);
  const board = await roomBoard(getDb(), ctx, {
    date: rawDate && DAY.test(rawDate) ? rawDate : undefined,
    floor: rawFloor && /^-?\d{1,3}$/.test(rawFloor) ? Number(rawFloor) : undefined,
    roomTypeId: one(sp.type) && /^[0-9a-f-]{36}$/i.test(one(sp.type)!) ? one(sp.type) : undefined,
    status: rawStatus && (DISPLAY_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as DisplayStatus) : undefined,
    q: one(sp.q)?.slice(0, 80),
    arrival: one(sp.arrival) && DAY.test(one(sp.arrival)!) ? one(sp.arrival) : undefined,
    checkout: one(sp.checkout) && DAY.test(one(sp.checkout)!) ? one(sp.checkout) : undefined,
    sort: one(sp.sort) === "checkout" || one(sp.sort) === "status" ? (one(sp.sort) as "checkout" | "status") : "number",
  });
  const view = one(sp.view) === "grid" ? "grid" : "table";
  const c = board.cards;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v && k !== "error" && k !== "ok") qs.set(k, v);
  const back = `/app/dashboard${qs.toString() ? `?${qs}` : ""}`;
  const canExport = roleHasPermission(ctx.role, "reports.export", ctx.extra);

  const cards: [string, string | number, string?][] = [
    ["Total rooms", c.totalRooms],
    ["Available rooms", c.available, c.availableReserved ? `${c.availableReserved} with a later booking` : undefined],
    ["Occupied rooms", c.occupied],
    ["Arrivals today", c.arrivalsToday],
    ["Checkouts today", c.checkoutsToday, "due, not yet checked out"],
    ["Checked out today", c.checkedOutToday],
    ["Out of order", c.outOfOrder],
    ["Under maintenance", c.maintenance],
    ["Expected revenue", inr(c.expectedRevenueMinor), "room nights at base rate, before tax"],
    ["Pending payments", c.pendingPaymentsMinor === null ? "—" : inr(c.pendingPaymentsMinor), "posted charges, in-house guests"],
  ];

  return (
    <>
      <PageHeader
        title="Room board"
        subtitle={board.live ? `Live status for ${board.date}` : `Projected for ${board.date} (housekeeping state shown for today only)`}
      />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" role="list" aria-label="Summary">
        {cards.map(([k, v, hint]) => (
          <div key={k} role="listitem">
            <Card>
              <div className="text-xs text-slate-500">{k}</div>
              <div className="text-2xl font-semibold">{v}</div>
              {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
            </Card>
          </div>
        ))}
      </div>

      <form method="get" className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-white p-3 md:grid-cols-4 lg:grid-cols-8" aria-label="Room filters">
        <input type="hidden" name="view" value={view} />
        <label className="text-xs text-slate-600">Date<input type="date" name="date" defaultValue={sp.date ? one(sp.date) : board.date} className={input} /></label>
        <label className="text-xs text-slate-600">Search<input name="q" defaultValue={one(sp.q)} placeholder="Room, guest, ref" className={input} /></label>
        <label className="text-xs text-slate-600">Status
          <select name="status" defaultValue={rawStatus ?? ""} className={input}>
            <option value="">All</option>
            {DISPLAY_STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Room type
          <select name="type" defaultValue={one(sp.type) ?? ""} className={input}>
            <option value="">All</option>
            {board.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Floor
          <select name="floor" defaultValue={rawFloor ?? ""} className={input}>
            <option value="">All</option>
            {board.floors.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">Arrival on<input type="date" name="arrival" defaultValue={one(sp.arrival)} className={input} /></label>
        <label className="text-xs text-slate-600">Checkout on<input type="date" name="checkout" defaultValue={one(sp.checkout)} className={input} /></label>
        <label className="text-xs text-slate-600">Sort
          <select name="sort" defaultValue={one(sp.sort) ?? "number"} className={input}>
            <option value="number">Room number</option>
            <option value="checkout">Checkout date</option>
            <option value="status">Status</option>
          </select>
        </label>
        <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-4 lg:col-span-8">
          <button className={btn}>Apply</button>
          <Link href="/app/dashboard" className={btnGhost}>Reset</Link>
          <span className="mx-2 text-xs text-slate-500">View:</span>
          <Link href={`/app/dashboard?${new URLSearchParams({ ...Object.fromEntries(qs), view: "table" })}`} className={btnGhost} aria-current={view === "table"}>Table</Link>
          <Link href={`/app/dashboard?${new URLSearchParams({ ...Object.fromEntries(qs), view: "grid" })}`} className={btnGhost} aria-current={view === "grid"}>Grid</Link>
          {canExport && <a href={`/app/dashboard/export?${qs}`} className={btnGhost}>Export CSV</a>}
        </div>
      </form>

      <div className="mt-3"><RoomStatusLegend /></div>
      <p className="mt-2 text-xs text-slate-500" aria-live="polite">Showing {board.rows.length} of {board.allRowCount} rooms.</p>

      {board.rows.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          {board.allRowCount === 0 ? <>No rooms are configured yet. <Link className="underline" href="/app/rooms">Add rooms</Link>.</> : "No rooms match these filters."}
        </p>
      ) : view === "grid" ? (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {board.rows.map((r) => (
            <li key={r.roomId} className={`rounded-lg border-2 p-3 ${STATUS_META[r.status].cell}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-lg font-semibold">Room {r.number}</div>
                  <div className="text-xs text-slate-600">{r.roomType}{r.floor !== null ? ` · Floor ${r.floor}` : ""}</div>
                </div>
                <RoomStatusChip status={r.status} />
              </div>
              <div className="mt-2 text-sm">{r.stay?.guest ?? (r.stay ? "Guest" : "—")}</div>
              <div className="text-xs text-slate-600"><Checkout row={r} time={board.checkOutTime} /></div>
              {r.reason && <div className="mt-1 text-xs font-medium text-slate-800">Reason: {r.reason}</div>}
              {r.balanceMinor !== null && r.balanceMinor !== 0 && <div className="mt-1 text-xs">Balance {inr(r.balanceMinor)}</div>}
              <div className="mt-2"><RowActions row={r} ctx={ctx} back={back} date={board.date} /></div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="p-2">Room</th><th>Type</th><th>Floor</th><th>Guest</th><th>Booking</th><th>Check-in</th>
                <th>Expected checkout</th><th>Status</th><th>Housekeeping</th><th>Payment</th><th>Balance</th><th>Reason</th><th>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {board.rows.map((r) => (
                <tr key={r.roomId} className="align-top">
                  <th scope="row" className="p-2 font-semibold">{r.number}</th>
                  <td>{r.roomType}</td>
                  <td>{r.floor ?? "—"}</td>
                  <td>{r.stay?.guest ?? (r.stay ? "Guest" : "—")}</td>
                  <td className="font-mono text-xs">{r.stay?.reference ?? "—"}</td>
                  <td>{r.stay ? shortDate(r.stay.arrival) : "—"}</td>
                  <td className="whitespace-nowrap"><Checkout row={r} time={board.checkOutTime} /></td>
                  <td><RoomStatusChip status={r.status} /></td>
                  <td><Badge value={r.housekeeping} /></td>
                  <td>{r.paymentStatus ? r.paymentStatus.replaceAll("_", " ").toLowerCase() : "—"}</td>
                  <td className="whitespace-nowrap">{r.balanceMinor === null ? "—" : inr(r.balanceMinor)}</td>
                  <td className="max-w-48 text-xs">{r.reason ?? "—"}</td>
                  <td className="p-2"><RowActions row={r} ctx={ctx} back={back} date={board.date} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        A room with a later booking is physically available today, so it counts as available. Booking state and room state are shown separately.
      </p>
    </>
  );
}
