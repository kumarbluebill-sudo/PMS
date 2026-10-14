import Link from "next/link";
import { cookies } from "next/headers";
import BoardPanel from "./BoardPanel";
import ViewMemory from "./ViewMemory";
import { roomStatusAction } from "@/app/actions";
import { Badge, btn, btnGhost, Card, EmptyState, ErrorBanner, inr, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import type { Ctx } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { DISPLAY_STATUSES, type DisplayStatus } from "@/server/domain/roomStatus";
import { occupancyPercent } from "@/server/domain/occupancy";
import { resolveStatusMeta, type StatusMeta } from "@/server/domain/settings";
import { settingsFor } from "@/server/services/settings";
import { getCtx } from "@/server/session";
import { complaintAlerts } from "@/server/services/feedback";
import { roomBoard, type BoardRow } from "@/server/services/dashboard";
import { ReservationActions } from "../ReservationActions";
import { RoomStatusChip, StatusKey } from "../RoomStatusChip";

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
      {(row.status === "OUT_OF_ORDER" || row.status === "MAINTENANCE") && can("rooms.view") && (
        <Link href={row.maintenanceId ? `/app/maintenance/${row.maintenanceId}` : "/app/maintenance"} className={btnGhost}>View reason</Link>
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

function FloorPlanView({ rows, meta }: { rows: BoardRow[]; meta: StatusMeta }) {
  const groups = new Map<string, BoardRow[]>();
  for (const r of rows) {
    const k = r.location ?? "Unassigned";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return (
    <div className="mt-3 space-y-4">
      {[...groups.entries()].map(([name, list]) => {
        const placed = list.filter((r) => r.layoutX !== null);
        const loose = list.filter((r) => r.layoutX === null);
        const cols = Math.max(1, ...placed.map((r) => r.layoutX! + 1));
        return (
          <section key={name} aria-label={name} className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="mb-2 text-sm font-semibold">{name}</h3>
            {placed.length > 0 && (
              <div className="overflow-x-auto">
                <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(5.5rem, 1fr))` }}>
                  {placed.map((r) => (
                    <div key={r.roomId} style={{ gridColumn: r.layoutX! + 1, gridRow: r.layoutY! + 1 }} className={`rounded border-2 p-1 text-xs ${meta[r.status].cell}`}>
                      <strong>{r.number}</strong> <span className="text-slate-600">{r.roomType}</span>
                      <RoomStatusChip status={r.status} meta={meta} />
                      {r.stay?.guest && <span className="block truncate">{r.stay.guest}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {loose.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {loose.map((r) => (
                  <li key={r.roomId} className={`rounded border-2 p-1 text-xs ${meta[r.status].cell}`}>
                    <strong>{r.number}</strong> <RoomStatusChip status={r.status} meta={meta} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <p className="text-xs text-slate-500">Rooms without a grid position are listed under their floor. Arrange tiles in <Link className="underline" href="/app/rooms/plan">Rooms › Floor plan</Link>.</p>
    </div>
  );
}

type View = "tiles" | "table" | "plan";

function TilesView({ rows, meta, ctx, back, date, time }: { rows: BoardRow[]; meta: StatusMeta; ctx: Ctx; back: string; date: string; time: string }) {
  const groups = new Map<string, BoardRow[]>();
  for (const r of rows) {
    const k = r.location ?? (r.floor !== null ? `Floor ${r.floor}` : "No floor assigned");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([name, list]) => (
        <section key={name} aria-label={name}>
          <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-slate-900">
            {name}
            <span className="text-xs font-normal text-slate-500">{list.length} room{list.length === 1 ? "" : "s"}</span>
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.map((r) => (
              <li key={r.roomId} className={`flex flex-col rounded-lg border-2 p-3 ${meta[r.status].cell}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xl font-semibold leading-none text-slate-900">{r.number}</div>
                    <div className="mt-1 text-xs text-slate-700">{r.roomType}</div>
                  </div>
                  <RoomStatusChip status={r.status} meta={meta} />
                </div>
                <div className="mt-3 min-h-10 text-sm text-slate-900">
                  {r.stay ? (
                    <>
                      <div className="truncate font-medium">{r.stay.guest ?? "Guest"}</div>
                      <div className="text-xs text-slate-700"><Checkout row={r} time={time} /></div>
                    </>
                  ) : (
                    <span className="text-xs text-slate-700">No guest</span>
                  )}
                  {r.reason && <div className="mt-1 text-xs font-medium text-slate-900">Reason: {r.reason}</div>}
                  {r.balanceMinor !== null && r.balanceMinor !== 0 && <div className="mt-1 text-xs font-medium text-slate-900">Balance due {inr(r.balanceMinor)}</div>}
                </div>
                <div className="mt-3"><RowActions row={r} ctx={ctx} back={back} date={date} /></div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default async function Dashboard({ searchParams }: PageProps<"/app/dashboard">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const rawDate = one(sp.date);
  const rawStatus = one(sp.status);
  const rawFloor = one(sp.floor);
  const status = rawStatus && (DISPLAY_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as DisplayStatus) : undefined;
  const board = await roomBoard(getDb(), ctx, {
    date: rawDate && DAY.test(rawDate) ? rawDate : undefined,
    buildingId: one(sp.building) && /^[0-9a-f-]{36}$/i.test(one(sp.building)!) ? one(sp.building) : undefined,
    floor: rawFloor && /^-?\d{1,3}$/.test(rawFloor) ? Number(rawFloor) : undefined,
    roomTypeId: one(sp.type) && /^[0-9a-f-]{36}$/i.test(one(sp.type)!) ? one(sp.type) : undefined,
    status,
    q: one(sp.q)?.slice(0, 80),
    arrival: one(sp.arrival) && DAY.test(one(sp.arrival)!) ? one(sp.arrival) : undefined,
    checkout: one(sp.checkout) && DAY.test(one(sp.checkout)!) ? one(sp.checkout) : undefined,
    sort: one(sp.sort) === "checkout" || one(sp.sort) === "status" ? (one(sp.sort) as "checkout" | "status") : "number",
  });
  const alerts = await complaintAlerts(getDb(), ctx);
  const meta: StatusMeta = resolveStatusMeta((await settingsFor(getDb(), ctx))["rooms.statusLabels"]);
  const remembered = (await cookies()).get("pms_dash_view")?.value;
  const pick = one(sp.view) ?? remembered;
  const view: View = pick === "table" ? "table" : pick === "plan" ? "plan" : "tiles";
  const c = board.cards;
  const occupancy = occupancyPercent(board.statusCounts);
  const sellable = c.totalRooms - board.statusCounts.OUT_OF_ORDER - board.statusCounts.MAINTENANCE;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v && k !== "error" && k !== "ok") qs.set(k, v);
  const back = `/app/dashboard${qs.toString() ? `?${qs}` : ""}`;
  const canExport = roleHasPermission(ctx.role, "reports.export", ctx.extra);
  const withParam = (k: string, v: string | null) => {
    const n = new URLSearchParams(qs);
    if (v === null) n.delete(k);
    else n.set(k, v);
    return n.toString() ? `/app/dashboard?${n}` : "/app/dashboard";
  };

  const stats: [string, string | number, string?][] = [
    ["Total rooms", c.totalRooms],
    ["Available to sell", c.available, c.availableReserved ? `${c.availableReserved} with a later booking` : undefined],
    ["Occupied", c.occupied],
    ["Expected revenue", inr(c.expectedRevenueMinor), "room nights, before tax"],
    ["Pending payments", c.pendingPaymentsMinor === null ? "—" : inr(c.pendingPaymentsMinor), "in-house guests"],
  ];
  const filtersOn = [rawStatus, one(sp.q), one(sp.type), one(sp.building), rawFloor, one(sp.arrival), one(sp.checkout)].filter(Boolean).length;
  const viewLabel: Record<View, string> = { tiles: "Tiles", table: "Table", plan: "Floor plan" };

  const panel = (
    <div className="space-y-4">
      <Card title="Occupancy">
        <div className="flex items-end justify-between">
          <div className="text-4xl font-semibold tabular-nums text-brand-900">{occupancy}%</div>
          <div className="text-right text-xs text-slate-600">{c.occupied} of {sellable} sellable rooms</div>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-200" role="progressbar" aria-label="Occupancy" aria-valuemin={0} aria-valuemax={100} aria-valuenow={occupancy}>
          <div className="h-full rounded-full bg-brand-600" style={{ width: `${occupancy}%` }} />
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-slate-600">
          <div><dd className="text-lg font-semibold tabular-nums text-slate-900">{c.arrivalsToday}</dd><dt>Arrivals</dt></div>
          <div><dd className="text-lg font-semibold tabular-nums text-slate-900">{c.checkoutsToday}</dd><dt>Due out</dt></div>
          <div><dd className="text-lg font-semibold tabular-nums text-slate-900">{c.checkedOutToday}</dd><dt>Left today</dt></div>
        </dl>
      </Card>

      <Card title="Room status key" actions={status ? <Link href={withParam("status", null)} className="text-xs text-brand-700 underline">Show all</Link> : undefined}>
        <StatusKey meta={meta} counts={board.statusCounts} active={status} hrefFor={(s) => withParam("status", s)} />
        <p className="mt-2 text-xs text-slate-500">A room with a later booking is available today, so it counts as available.</p>
      </Card>

      <Card title="View">
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Room view">
          {(["tiles", "table", "plan"] as const).map((v) => (
            <Link key={v} href={withParam("view", v)} aria-current={view === v ? "true" : undefined}
              className={`rounded-md border px-2 py-1.5 text-center text-xs font-medium ${view === v ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
              {viewLabel[v]}
            </Link>
          ))}
        </div>
      </Card>

      <Card title="Filters" actions={filtersOn > 0 ? <span className="text-xs text-slate-600">{filtersOn} on</span> : undefined}>
        <form method="get" className="space-y-2.5" aria-label="Room filters">
          <input type="hidden" name="view" value={view} />
          {status && <input type="hidden" name="status" value={status} />}
          <label className="block text-xs text-slate-600">Date<input type="date" name="date" defaultValue={rawDate ?? board.date} className={input} /></label>
          <label className="block text-xs text-slate-600">Search<input name="q" defaultValue={one(sp.q)} placeholder="Room, guest, reference" className={input} /></label>
          <label className="block text-xs text-slate-600">Room type
            <select name="type" defaultValue={one(sp.type) ?? ""} className={input}>
              <option value="">All</option>
              {board.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {board.buildings.length > 0 && (
            <label className="block text-xs text-slate-600">Building
              <select name="building" defaultValue={one(sp.building) ?? ""} className={input}>
                <option value="">All</option>
                {board.buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <label className="block text-xs text-slate-600">Floor
            <select name="floor" defaultValue={rawFloor ?? ""} className={input}>
              <option value="">All</option>
              {board.floors.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-600">Arrival on<input type="date" name="arrival" defaultValue={one(sp.arrival)} className={input} /></label>
            <label className="block text-xs text-slate-600">Checkout on<input type="date" name="checkout" defaultValue={one(sp.checkout)} className={input} /></label>
          </div>
          <label className="block text-xs text-slate-600">Sort by
            <select name="sort" defaultValue={one(sp.sort) ?? "number"} className={input}>
              <option value="number">Room number</option>
              <option value="checkout">Checkout date</option>
              <option value="status">Status</option>
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className={btn}>Apply</button>
            <Link href={`/app/dashboard?view=${view}`} className={btnGhost}>Reset</Link>
            {canExport && <a href={`/app/dashboard/export?${qs}`} className={btnGhost}>Export CSV</a>}
          </div>
        </form>
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Room board"
        subtitle={board.live ? `Live status for ${board.date}` : `Projected for ${board.date} (housekeeping state shown for today only)`}
      />
      <ViewMemory view={view} />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />

      {alerts.open > 0 && (
        <p role="alert" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {alerts.open} low-rating guest complaint(s) need follow-up. <Link className="underline" href="/app/feedback?rating=low">Review feedback</Link>
        </p>
      )}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-6">
        <div className="min-w-0">
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-5" role="list" aria-label="Summary">
            {stats.map(([k, v, hint]) => (
              <div key={k} role="listitem">
                <Card>
                  <div className="text-xs text-slate-600">{k}</div>
                  <div className="text-2xl font-semibold tabular-nums text-brand-900">{v}</div>
                  {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
                </Card>
              </div>
            ))}
          </div>

          <p className="mb-3 text-xs text-slate-600" aria-live="polite">Showing {board.rows.length} of {board.allRowCount} rooms{status ? ` · ${meta[status].label} only` : ""}.</p>

          {board.rows.length === 0 ? (
            <EmptyState title={board.allRowCount === 0 ? "No rooms are set up yet" : "No rooms match these filters"}>
              {board.allRowCount === 0 ? <><Link className="underline" href="/app/rooms">Add rooms</Link> to see them here.</> : <>Change the filters or <Link className="underline" href={`/app/dashboard?view=${view}`}>reset them</Link>.</>}
            </EmptyState>
          ) : view === "plan" ? (
            <FloorPlanView rows={board.rows} meta={meta} />
          ) : view === "tiles" ? (
            <TilesView rows={board.rows} meta={meta} ctx={ctx} back={back} date={board.date} time={board.checkOutTime} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th>Room</th><th>Type</th><th>Floor</th><th>Guest</th><th>Booking</th><th>Check-in</th>
                    <th>Expected checkout</th><th>Status</th><th>Housekeeping</th><th>Payment</th><th>Balance</th><th>Reason</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {board.rows.map((r) => (
                    <tr key={r.roomId} className="align-top">
                      <th scope="row" className="font-semibold">{r.number}</th>
                      <td>{r.roomType}</td>
                      <td>{r.floor ?? "—"}</td>
                      <td>{r.stay?.guest ?? (r.stay ? "Guest" : "—")}</td>
                      <td className="font-mono text-xs">{r.stay?.reference ?? "—"}</td>
                      <td>{r.stay ? shortDate(r.stay.arrival) : "—"}</td>
                      <td className="whitespace-nowrap"><Checkout row={r} time={board.checkOutTime} /></td>
                      <td><RoomStatusChip status={r.status} meta={meta} /></td>
                      <td><Badge value={r.housekeeping} /></td>
                      <td>{r.paymentStatus ? r.paymentStatus.replaceAll("_", " ").toLowerCase() : "—"}</td>
                      <td className="whitespace-nowrap">{r.balanceMinor === null ? "—" : inr(r.balanceMinor)}</td>
                      <td className="max-w-48 text-xs">{r.reason ?? "—"}</td>
                      <td><RowActions row={r} ctx={ctx} back={back} date={board.date} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="lg:sticky lg:top-4">
          <BoardPanel summary={viewLabel[view] + (filtersOn ? `, ${filtersOn} filter${filtersOn === 1 ? "" : "s"}` : "")}>{panel}</BoardPanel>
        </div>
      </div>
    </>
  );
}
