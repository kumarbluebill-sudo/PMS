import Link from "next/link";
import { cookies } from "next/headers";
import AutoRefresh from "./AutoRefresh";
import BoardPanel from "./BoardPanel";
import ViewMemory from "./ViewMemory";
import { roomStatusAction } from "@/app/actions";
import { Badge, btn, btnGhost, Card, EmptyState, ErrorBanner, inr, input } from "@/app/ui";
import { Bars } from "@/components/charts";
import { roleHasPermission } from "@/server/auth/permissions";
import type { Ctx } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { DISPLAY_STATUSES, type DisplayStatus } from "@/server/domain/roomStatus";
import type { Severity } from "@/server/domain/kpi";
import { occupancyPercent } from "@/server/domain/occupancy";
import { resolveStatusMeta, type StatusMeta } from "@/server/domain/settings";
import { settingsFor } from "@/server/services/settings";
import { getCtx } from "@/server/session";
import { isManagerView, listAlerts } from "@/server/services/alerts";
import { rangeKpis } from "@/server/services/analytics";
import { housekeepingSummary, operations } from "@/server/services/frontoffice";
import { roomBoard, type BoardRow } from "@/server/services/dashboard";
import { ReservationActions } from "../ReservationActions";
import { RoomStatusChip, StatusChips } from "../RoomStatusChip";

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
        <Link href={`/app/reservations/new?roomTypeId=${row.roomTypeId}&roomId=${row.roomId}&arrival=${date}`} className={btnGhost}>New booking</Link>
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

const ICON: Record<Severity, string> = { CRITICAL: "⛔", WARNING: "⚠", INFO: "ℹ" };
const SEV_LABEL: Record<Severity, string> = { CRITICAL: "Critical", WARNING: "Warning", INFO: "Information" };
const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Tile = { label: string; value: string | number; hint: string; href: string; tone?: "warn" | "bad"; extra?: string };

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
  const [ops, kpi, hk, settings] = await Promise.all([
    operations(getDb(), ctx),
    rangeKpis(getDb(), ctx, { from: addDay(board.today, -1), days: 9 }),
    housekeepingSummary(getDb(), ctx),
    settingsFor(getDb(), ctx),
  ]);
  const alerts = await listAlerts(getDb(), ctx, { ops });
  const meta: StatusMeta = resolveStatusMeta(settings["rooms.statusLabels"]);
  const manager = isManagerView(ctx);
  const remembered = (await cookies()).get("pms_dash_view")?.value;
  const pick = one(sp.view) ?? remembered;
  const view: View = pick === "table" ? "table" : pick === "plan" ? "plan" : "tiles";
  const c = board.cards;
  const sc = board.statusCounts;
  const sellable = c.totalRooms - sc.OUT_OF_ORDER - sc.MAINTENANCE;
  const occupancy = occupancyPercent(sc);
  const yesterday = kpi.days.find((d) => d.date === addDay(board.today, -1));
  const todayK = kpi.days.find((d) => d.date === board.today);
  const next7 = kpi.days.filter((d) => d.kind === "FORECAST").slice(0, 7);
  const delta = yesterday && todayK ? Math.round((occupancy - yesterday.occupancyPct) * 10) / 10 : null;
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
  const live = board.live;
  const revenue = todayK?.revenueMinor ?? null;
  const walkIns = ops.arrivalsExpected.filter((o) => o.source === "WALK_IN").length;
  const filtersOn = [rawStatus, one(sp.q), one(sp.type), one(sp.building), rawFloor, one(sp.arrival), one(sp.checkout)].filter(Boolean).length;
  const viewLabel: Record<View, string> = { tiles: "Tiles", table: "Table", plan: "Floor plan" };

  const tiles: Tile[] = [
    { label: "Physical rooms", value: c.totalRooms, hint: "Every room in the property", href: "/app/dashboard" },
    { label: "Sellable rooms", value: sellable, hint: "Physical rooms minus out of order and maintenance", href: "/app/dashboard" },
    { label: "Available", value: sc.AVAILABLE + sc.RESERVED, hint: "Ready to sell, including rooms with a later booking", href: withParam("status", "AVAILABLE") },
    { label: "Occupied", value: sc.OCCUPIED + sc.DUE_OUT, hint: "Guest in the room (including checkout due)", href: withParam("status", "OCCUPIED") },
    { label: "Reserved", value: sc.RESERVED, hint: "Free today, booked for a later date", href: withParam("status", "RESERVED") },
    { label: "Checkout due", value: sc.DUE_OUT, hint: "Checkout date reached, guest still in", href: withParam("status", "DUE_OUT"), tone: sc.DUE_OUT ? "warn" : undefined },
    { label: "Cleaning", value: sc.CLEANING, hint: "Stay ended, room not ready for sale", href: withParam("status", "CLEANING") },
    { label: "Out of order", value: sc.OUT_OF_ORDER, hint: "Cannot be sold: recorded issue", href: withParam("status", "OUT_OF_ORDER"), tone: sc.OUT_OF_ORDER ? "bad" : undefined },
    { label: "Occupancy", value: `${occupancy}%`, hint: "Occupied sellable rooms / sellable rooms", href: "/app/dashboard/analytics", extra: delta === null ? undefined : `${delta > 0 ? "▲" : delta < 0 ? "▼" : "="} ${Math.abs(delta)} pts vs yesterday` },
    { label: "Arrivals", value: ops.arrivalsExpected.length, hint: "Expected today (confirmed or checked in)", href: "/app/operations#arrivals" },
    { label: "Departures", value: ops.departuresExpected.length, hint: "Checked-in guests leaving today", href: "/app/operations#departures" },
    { label: "Walk-ins", value: walkIns, hint: "Today's arrivals booked as walk-in", href: "/app/operations#arrivals" },
    { label: "No-shows to review", value: ops.noShowCandidates.length, hint: `Past arrival date or after ${ops.noShowCutoff} today. Staff confirm each one.`, href: "/app/operations#no-shows", tone: ops.noShowCandidates.length ? "warn" : undefined },
    { label: "Pending check-ins", value: ops.yetToArrive.length, hint: "Confirmed arrivals not yet checked in", href: "/app/operations#yet-to-arrive" },
    { label: "Pending payments", value: c.pendingPaymentsMinor === null ? "—" : rupees(c.pendingPaymentsMinor), hint: "Outstanding on in-house guests", href: "/app/operations#unpaid" },
    ...(kpi.revenueVisible
      ? [
          { label: "Room revenue today", value: revenue === null ? "—" : rupees(revenue), hint: `Net of tax. Posted ${rupees(todayK?.postedMinor ?? 0)}, estimated from booked rates ${rupees(todayK?.estimatedMinor ?? 0)}`, href: "/app/dashboard/analytics" },
          { label: "ARR", value: todayK?.arrMinor == null ? "—" : rupees(todayK.arrMinor), hint: "Room revenue per room sold today", href: "/app/dashboard/analytics" },
          { label: "RevPAR", value: todayK?.revparMinor == null ? "—" : rupees(todayK.revparMinor), hint: "Room revenue per available sellable room today", href: "/app/dashboard/analytics" },
        ]
      : []),
  ];

  const performance = (
    <div className="space-y-4">
      <Card title="Occupancy" actions={<span className="text-[11px] text-slate-500">{live ? "Live, today" : `Projected ${board.date}`}</span>}>
        <div className="flex items-end justify-between">
          <div className="text-4xl font-semibold tabular-nums text-brand-900">{occupancy}%</div>
          <div className="text-right text-xs text-slate-600">{sc.OCCUPIED + sc.DUE_OUT} of {sellable} sellable rooms{delta !== null && <span className="block">{delta > 0 ? "▲" : delta < 0 ? "▼" : "="} {Math.abs(delta)} pts vs yesterday</span>}</div>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-200" role="progressbar" aria-label="Occupancy" aria-valuemin={0} aria-valuemax={100} aria-valuenow={occupancy}><div className="h-full rounded-full bg-brand-600" style={{ width: `${occupancy}%` }} /></div>
        {next7.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-medium text-slate-700">Next {next7.length} nights <span className="font-normal text-slate-500">(forecast, estimate)</span></p>
            <Bars title="Expected occupancy, next nights" format={(n) => `${n}%`} max={100} data={next7.map((d) => ({ label: new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "UTC" }), value: d.occupancyPct, hatched: true, note: "Forecast" }))} />
          </div>
        )}
        <p className="mt-2 text-xs"><Link className="text-brand-700 underline" href="/app/dashboard/analytics">Occupancy, ARR and revenue analytics</Link></p>
      </Card>

      <Card title={`Alerts (${alerts.filter((a) => !a.ack).length} open)`} actions={<Link href="/app/alerts" className="text-xs text-brand-700 underline">All alerts</Link>}>
        {alerts.length === 0 ? <p className="text-sm text-slate-600">Nothing needs attention right now.</p> : (
          <ul className="space-y-1.5">
            {alerts.slice(0, 6).map((a) => (
              <li key={a.key}>
                <Link href={a.href} className={`block rounded-md border px-2 py-1.5 text-xs ${a.severity === "CRITICAL" ? "border-red-300 bg-red-50 text-red-900" : a.severity === "WARNING" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-brand-200 bg-brand-50 text-brand-900"} ${a.ack ? "opacity-70" : ""}`}>
                  <span className="font-medium"><span aria-hidden>{ICON[a.severity]} </span><span className="sr-only">{SEV_LABEL[a.severity]}: </span>{a.title}</span>
                  <span className="block">{a.detail}</span>
                  {a.ack && <span className="block italic">Acknowledged by {a.ack.by}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Housekeeping and maintenance">
        {hk.board ? (
          <ul aria-label="Housekeeping summary" className="grid grid-cols-2 gap-2 text-center text-xs text-slate-700">
            {([["Awaiting cleaning", hk.board.awaitingCleaning, "awaiting-cleaning"], ["Being cleaned", hk.board.beingCleaned, "cleaning"], ["Awaiting inspection", hk.board.awaitingInspection, "awaiting-inspection"], ["Clean and ready", hk.board.ready, "ready"], ["Arrivals, room not ready", hk.board.arrivalsNotReady, "arrivals-not-ready"], ["Overdue tasks", hk.board.overdue, "overdue"]] as const).map(([l, v, st]) => (
              <li key={l}><Link href={`/app/housekeeping?state=${st}`} className={`block rounded-md bg-slate-50 p-2 hover:bg-brand-50 ${v > 0 && (st === "arrivals-not-ready" || st === "overdue") ? "border-l-4 border-red-700" : ""}`}><span className="block text-lg font-semibold tabular-nums text-slate-900">{v}</span><span>{l}</span></Link></li>
            ))}
          </ul>
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-center text-xs text-slate-600">
            {([["Needs cleaning", hk.needsCleaning], ["Being cleaned", hk.beingCleaned], ["Clean, not inspected", hk.awaitingInspection], ["Inspected, ready", hk.inspectedReady]] as const).map(([l, v]) => (
              <div key={l} className="rounded-md bg-slate-50 p-2"><dd className="text-lg font-semibold tabular-nums text-slate-900">{v}</dd><dt>{l}</dt></div>
            ))}
          </dl>
        )}
        <ul className="mt-3 space-y-1 text-xs text-slate-700">
          <li>Open housekeeping tasks: <strong>{hk.openTasks}</strong></li>
          <li>Open maintenance requests: <strong>{hk.openMaintenance}</strong> ({hk.blockedRooms} blocking a room)</li>
          <li>Arrivals with a ready room: <strong>{ops.yetToArrive.filter((o) => o.roomReady).length}</strong> of {ops.yetToArrive.length}</li>
        </ul>
        {hk.outOfOrder.length > 0 && (
          <ul className="mt-2 divide-y text-xs" aria-label="Out-of-order rooms">
            {hk.outOfOrder.map((r) => <li key={r.id}><Link className="flex justify-between gap-2 py-1 hover:underline" href={`/app/maintenance/${r.id}`}><span className="font-medium">Room {r.room}</span><span className="truncate text-slate-600">{r.reason}</span></Link></li>)}
          </ul>
        )}
        <p className="mt-2 text-xs"><Link className="text-brand-700 underline" href="/app/housekeeping">Housekeeping</Link> · <Link className="text-brand-700 underline" href="/app/maintenance">Maintenance</Link></p>
      </Card>

      {manager && (
        <Card title="Manager">
          <ul className="space-y-1 text-xs text-slate-700">
            <li>Pending approvals: <strong>{alerts.filter((a) => a.kind === "PENDING_APPROVAL").length}</strong></li>
            <li>Overdue departures: <strong>{ops.overdueDepartures.length}</strong></li>
            <li>Allocation conflicts: <strong>{ops.conflicts.length}</strong></li>
            <li>Billing adjustments in 24 h: <strong>{alerts.filter((a) => a.kind === "BILLING_ADJUSTMENT").length}</strong></li>
          </ul>
          <p className="mt-2 text-xs"><Link className="text-brand-700 underline" href="/app/alerts">Staff activity and exceptions</Link> · <Link className="text-brand-700 underline" href="/app/audit-logs">Audit log</Link></p>
        </Card>
      )}
    </div>
  );

  return (
    <>
      <AutoRefresh seconds={Number(settings["frontoffice.dashboardRefreshSeconds"] ?? 0)} />
      <ViewMemory view={view} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Front office command centre</h1>
          <p className="text-xs text-slate-600">
            <span className={`mr-1.5 inline-block rounded-full px-2 py-0.5 font-medium ${live ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}>{live ? "Live status, today" : `Projected for ${board.date}`}</span>
            Room status is live; the figures beside it are today&apos;s totals and forecasts, each labelled.
          </p>
        </div>
        <form method="get" className="flex items-center gap-1.5">
          <input type="hidden" name="view" value={view} />
          <label className="sr-only" htmlFor="dash-date">Business date</label>
          <input id="dash-date" type="date" name="date" defaultValue={rawDate ?? board.date} className={`${input} w-40`} />
          <button className={btn}>Show</button>
          <Link href={back} className={btnGhost} prefetch={false}>Refresh</Link>
        </form>
      </div>
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />

      <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,72fr)_minmax(0,28fr)] lg:items-start lg:gap-5">
        <div className="min-w-0 lg:h-[calc(100vh-10.75rem)] lg:overflow-y-auto lg:pr-1">
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" role="list" aria-label="Hotel performance summary">
            {tiles.map((t) => (
              <div key={t.label} role="listitem">
                <Link href={t.href} title={t.hint} className={`block rounded-lg border bg-white px-3 py-2 shadow-[0_1px_2px_rgba(26,32,26,0.05)] transition-colors hover:border-brand-500 ${t.tone === "bad" ? "border-red-300" : t.tone === "warn" ? "border-amber-300" : "border-slate-200"}`}>
                  <span className="block text-[11px] leading-tight text-slate-600">{t.label}</span>
                  <span className="block text-xl font-semibold tabular-nums text-brand-900">{t.value}</span>
                  {t.extra && <span className="block text-[10px] text-slate-600">{t.extra}</span>}
                </Link>
              </div>
            ))}
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <StatusChips meta={meta} counts={sc} active={status} hrefFor={(s) => withParam("status", s)} />
            <div className="flex items-center gap-1.5" role="group" aria-label="Room view">
              {(["tiles", "table", "plan"] as const).map((v) => (
                <Link key={v} href={withParam("view", v)} aria-current={view === v ? "true" : undefined} className={`rounded-md border px-2.5 py-1 text-xs font-medium ${view === v ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>{viewLabel[v]}</Link>
              ))}
            </div>
          </div>

          <details className="mb-3 rounded-lg border border-slate-200 bg-white" open={filtersOn > 0}>
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-800">Filters{filtersOn > 0 ? ` (${filtersOn} on)` : ""}</summary>
            <form method="get" className="grid grid-cols-2 gap-2 border-t p-3 md:grid-cols-4" aria-label="Room filters">
              <input type="hidden" name="view" value={view} />
              {status && <input type="hidden" name="status" value={status} />}
              {rawDate && <input type="hidden" name="date" value={rawDate} />}
              <label className="text-xs text-slate-600">Guest, room or reference<input name="q" defaultValue={one(sp.q)} placeholder="Search" className={input} /></label>
              <label className="text-xs text-slate-600">Room category
                <select name="type" defaultValue={one(sp.type) ?? ""} className={input}><option value="">All</option>{board.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </label>
              {board.buildings.length > 0 && (
                <label className="text-xs text-slate-600">Building
                  <select name="building" defaultValue={one(sp.building) ?? ""} className={input}><option value="">All</option>{board.buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                </label>
              )}
              <label className="text-xs text-slate-600">Floor
                <select name="floor" defaultValue={rawFloor ?? ""} className={input}><option value="">All</option>{board.floors.map((f) => <option key={f} value={f}>{f}</option>)}</select>
              </label>
              <label className="text-xs text-slate-600">Arrival on<input type="date" name="arrival" defaultValue={one(sp.arrival)} className={input} /></label>
              <label className="text-xs text-slate-600">Checkout on<input type="date" name="checkout" defaultValue={one(sp.checkout)} className={input} /></label>
              <label className="text-xs text-slate-600">Sort by
                <select name="sort" defaultValue={one(sp.sort) ?? "number"} className={input}><option value="number">Room number</option><option value="checkout">Checkout date</option><option value="status">Status</option></select>
              </label>
              <div className="col-span-2 flex flex-wrap items-end gap-2 md:col-span-4">
                <button className={btn}>Apply</button>
                <Link href={`/app/dashboard?view=${view}`} className={btnGhost}>Reset</Link>
                {canExport && <a href={`/app/dashboard/export?${qs}`} className={btnGhost}>Export CSV</a>}
              </div>
            </form>
          </details>

          <p className="mb-2 text-xs text-slate-600" aria-live="polite">Showing {board.rows.length} of {board.allRowCount} rooms{status ? ` · ${meta[status].label} only` : ""}.</p>

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

        <div className="order-first lg:order-none lg:h-[calc(100vh-10.75rem)] lg:overflow-y-auto lg:pr-1">
          <BoardPanel label="Performance and alerts" summary={`${occupancy}% occupied · ${alerts.filter((a) => !a.ack).length} alerts`}>{performance}</BoardPanel>
        </div>
      </div>
    </>
  );
}
