import Link from "next/link";
import { btn, btnGhost, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { addDays, RACK_RANGES } from "@/server/domain/rack";
import { getCtx } from "@/server/session";
import { propertyToday } from "@/server/services/roomBlocks";
import { rack } from "@/server/services/stays";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reservation status is shown by colour, an icon and a text label; the room's own status is shown in the left column. */
const STATUS: Record<string, { label: string; icon: string; cls: string }> = {
  TENTATIVE: { label: "Pending", icon: "◔", cls: "border-dashed border-amber-600 bg-amber-50 text-amber-950" },
  CONFIRMED: { label: "Confirmed", icon: "●", cls: "border-blue-600 bg-blue-100 text-blue-950" },
  CHECKED_IN: { label: "In house", icon: "▶", cls: "border-green-700 bg-green-100 text-green-950" },
  CHECKED_OUT: { label: "Checked out", icon: "■", cls: "border-slate-500 bg-slate-100 text-slate-800" },
};
const HK: Record<string, string> = { CLEAN: "Clean", DIRTY: "Dirty", CLEANING: "Cleaning", INSPECTED: "Inspected" };
const STRIPES = { backgroundImage: "repeating-linear-gradient(45deg, rgb(203 213 225) 0 6px, rgb(241 245 249) 6px 12px)" };

export default async function CalendarPage({ searchParams }: PageProps<"/app/reservations/calendar">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const today = await propertyToday(db, ctx);
  const start = DAY_RE.test(one(sp.start)) ? one(sp.start) : today;
  const reqDays = Number(one(sp.days));
  const days = (RACK_RANGES as readonly number[]).includes(reqDays) ? reqDays : 14;
  const show = (["occupied", "vacant"] as const).find((s) => s === one(sp.show)) ?? "all";
  const f = { buildingId: one(sp.buildingId), floorId: one(sp.floorId), roomTypeId: one(sp.roomTypeId), q: one(sp.q) };
  const data = await rack(db, ctx, { start, days, show, buildingId: f.buildingId || undefined, floorId: f.floorId || undefined, roomTypeId: f.roomTypeId || undefined, q: f.q || undefined });
  const canCreate = roleHasPermission(ctx.role, "reservations.create", ctx.extra);

  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const link = (over: Record<string, string | number>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ start, days, show, ...f, ...over })) if (String(v) && !(k === "show" && v === "all")) p.set(k, String(v));
    return `/app/reservations/calendar?${p}`;
  };
  const cols = `9.5rem repeat(${days}, minmax(3.25rem, 1fr))`;
  const minW = `${9.5 + days * 3.25}rem`;
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { ...o, timeZone: "UTC" });

  return (
    <>
      <PageHeader
        title="Room calendar"
        subtitle={`${fmt(start, { day: "numeric", month: "short", year: "numeric" })} to ${fmt(addDays(start, days - 1), { day: "numeric", month: "short", year: "numeric" })}. A bar runs from the arrival night to the night before departure.`}
        actions={canCreate ? <Link href="/app/reservations/new" className={btn}>New reservation</Link> : undefined}
      />

      <form method="get" role="search" aria-label="Calendar filters" className="mb-3 grid gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Jump to date</span><input type="date" name="start" defaultValue={start} className={input} /></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Range</span>
          <select name="days" defaultValue={days} className={input}>{RACK_RANGES.map((n) => <option key={n} value={n}>{n === 7 ? "1 week" : n === 14 ? "2 weeks" : "30 days"}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Building</span>
          <select name="buildingId" defaultValue={f.buildingId} className={input}><option value="">All buildings</option>{data.buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Floor</span>
          <select name="floorId" defaultValue={f.floorId} className={input}><option value="">All floors</option>{data.floors.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Room category</span>
          <select name="roomTypeId" defaultValue={f.roomTypeId} className={input}><option value="">All categories</option>{data.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Show rooms</span>
          <select name="show" defaultValue={show} className={input}><option value="all">All rooms</option><option value="occupied">With a stay in range</option><option value="vacant">Vacant in range</option></select></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-xs font-medium text-slate-700">Room number or guest</span>
          <input name="q" defaultValue={f.q} placeholder="e.g. 204 or Verma" className={input} /></label>
        <div className="flex items-end gap-2 sm:col-span-1 lg:col-span-2">
          <button className={btn}>Apply</button>
          <Link href="/app/reservations/calendar" className={btnGhost}>Reset</Link>
        </div>
      </form>

      <nav aria-label="Calendar dates" className="mb-2 flex flex-wrap items-center gap-2">
        <Link className={btnGhost} href={link({ start: addDays(start, -days) })}>← Previous {days === 7 ? "week" : days} {days === 7 ? "" : "days"}</Link>
        <Link className={btnGhost} href={link({ start: today })}>Today</Link>
        <Link className={btnGhost} href={link({ start: addDays(start, days) })}>Next {days === 7 ? "week" : `${days} days`} →</Link>
        <span className="ml-auto text-xs text-slate-600">{data.rooms.length} room{data.rooms.length === 1 ? "" : "s"}</span>
      </nav>

      <ul aria-label="Calendar key" className="mb-2 flex flex-wrap gap-2 text-xs">
        {Object.entries(STATUS).map(([k, s]) => (
          <li key={k} className={`rounded border px-2 py-0.5 ${s.cls}`}><span aria-hidden>{s.icon}</span> {s.label}</li>
        ))}
        <li className="rounded border border-slate-400 px-2 py-0.5 text-slate-800" style={STRIPES}>▨ Room blocked</li>
        <li className="rounded border border-red-600 bg-red-50 px-2 py-0.5 text-red-900">⚠ Stay overlaps a block</li>
        <li className="rounded border border-brand-600 bg-white px-2 py-0.5 text-brand-900">⇄ Same-day turnover</li>
      </ul>

      {data.rooms.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-700">No rooms match these filters.</p>
      ) : (
        <div className="relative max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white" tabIndex={0} role="region" aria-label="Room calendar, scrolls in both directions">
          <div style={{ minWidth: minW }}>
            <div className="sticky top-0 z-30 grid border-b border-slate-300 bg-slate-50 text-xs" style={{ gridTemplateColumns: cols }}>
              <div className="sticky left-0 z-40 border-r border-slate-300 bg-slate-50 p-2 font-medium text-slate-800">Room</div>
              {dates.map((d) => (
                <div key={d} className={`border-l border-slate-200 p-1 text-center ${d === today ? "bg-brand-100 font-semibold text-brand-900" : [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) ? "bg-slate-100 text-slate-700" : "text-slate-700"}`}>
                  <span className="block">{fmt(d, { weekday: "short" })}</span>
                  <span className="block tabular-nums">{fmt(d, { day: "numeric", month: "short" })}</span>
                </div>
              ))}
            </div>
            {data.rooms.map((r) => {
              const covered = new Set<number>();
              for (const b of [...r.bars, ...r.blocks]) for (let i = b.col; i < b.col + b.span; i++) covered.add(i);
              return (
                <div key={r.id} className="grid border-b border-slate-100" style={{ gridTemplateColumns: cols }}>
                  <div className="sticky left-0 z-20 border-r border-slate-200 bg-white p-1.5" style={{ gridRow: 1, gridColumn: 1 }}>
                    <span className="block text-sm font-semibold text-slate-900">{r.number}</span>
                    <span className="block truncate text-[11px] text-slate-600" title={`${r.type}${r.floor ? ` · ${r.floor}` : ""}`}>{r.type}{r.floor ? ` · ${r.floor}` : ""}</span>
                    <span className={`block text-[11px] ${r.outOfOrder ? "font-medium text-red-800" : "text-slate-600"}`}>{r.outOfOrder ? "Out of order" : HK[r.housekeeping] ?? r.housekeeping}</span>
                  </div>
                  {dates.map((d, i) =>
                    canCreate && !covered.has(i) ? (
                      <Link
                        key={d} tabIndex={-1} style={{ gridRow: 1, gridColumn: i + 2 }}
                        aria-label={`Book room ${r.number} from ${fmt(d, { day: "numeric", month: "short" })}`}
                        href={`/app/reservations/new?roomTypeId=${r.typeId}&roomId=${r.id}&arrival=${d}&departure=${addDays(d, 1)}`}
                        className={`min-h-12 border-l border-slate-100 hover:bg-brand-50 ${d === today ? "bg-brand-50/60" : ""}`}
                      />
                    ) : (
                      <div key={d} style={{ gridRow: 1, gridColumn: i + 2 }} className={`min-h-12 border-l border-slate-100 ${d === today ? "bg-brand-50/60" : ""}`} />
                    ),
                  )}
                  {r.blocks.map((b, i) => (
                    <div key={`b${i}`} style={{ ...STRIPES, gridRow: 1, gridColumn: `${b.col + 2} / span ${b.span}` }} className="z-10 m-0.5 flex items-center overflow-hidden rounded border border-slate-400 px-1.5 text-[11px] font-medium text-slate-900" title={`Blocked: ${b.title}`}>
                      <span className="truncate">{b.mode === "OUT_OF_ORDER" ? "Out of order" : "Blocked"}: {b.title}</span>
                    </div>
                  ))}
                  {r.bars.map((b) => {
                    const s = STATUS[b.status] ?? STATUS.CONFIRMED;
                    const turnover = r.bars.some((o) => o.id !== b.id && o.departureCol !== null && o.departureCol === b.arrivalCol);
                    const label = `${b.guest}, ${s.label}, reference ${b.reference}, room ${r.number}, ${b.arrival} to ${b.departure}${b.conflict ? ", overlaps a room block" : ""}${turnover ? ", same-day turnover" : ""}`;
                    return (
                      <Link
                        key={b.id} href={`/app/reservations/${b.reservationId}`} aria-label={label} title={label}
                        style={{ gridRow: 1, gridColumn: `${b.col + 2} / span ${b.span}` }}
                        className={`z-10 m-0.5 flex min-w-0 items-center gap-1 overflow-hidden border px-1.5 text-[11px] font-medium shadow-sm hover:brightness-95 focus-visible:z-20 ${s.cls} ${b.cutLeft ? "rounded-l-none border-l-0" : "rounded-l-lg"} ${b.cutRight ? "rounded-r-none border-r-0" : "rounded-r-lg"} ${b.conflict ? "ring-2 ring-red-600" : turnover ? "ring-2 ring-brand-600" : ""}`}
                      >
                        <span aria-hidden>{b.conflict ? "⚠" : s.icon}</span>
                        <span className="truncate">{b.guest}{b.vip ? " ★" : ""}</span>
                        {b.span >= 3 && <span className="hidden truncate font-normal opacity-80 sm:inline">{s.label}</span>}
                        {turnover && <span aria-hidden>⇄</span>}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-600">
        Select a bar to open the reservation, where you can check in or out, open the folio, extend the stay or move the room. Select an empty cell to book that room.
        The room&rsquo;s housekeeping state is in the left column and is separate from the reservation status.
      </p>
    </>
  );
}
