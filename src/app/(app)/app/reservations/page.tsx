import Link from "next/link";
import { Badge, btn, btnGhost, Card, EmptyState, fmtDate, inr, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { BOOKING_SOURCES, SOURCE_LABELS } from "@/server/domain/quote";
import { getCtx } from "@/server/session";
import { roleHasPermission } from "@/server/auth/permissions";
import { listRoomTypes, listRooms } from "@/server/services/rooms";
import { listReservationsPage, RESERVATION_SORTS, type ReservationListFilter } from "@/server/services/reservations";
import { ReservationActions } from "../ReservationActions";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const STATUSES = ["TENTATIVE", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"];
const PAYMENTS = [["UNPAID", "Unpaid"], ["PARTIAL", "Part paid"], ["PAID", "Paid"]] as const;
const SORT_LABELS: Record<(typeof RESERVATION_SORTS)[number], string> = { arrival: "Arrival", departure: "Departure", created: "Booked on", guest: "Guest name" };

export default async function Reservations({ searchParams }: PageProps<"/app/reservations">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);

  const sort = (RESERVATION_SORTS as readonly string[]).includes(one(sp.sort)) ? (one(sp.sort) as ReservationListFilter["sort"]) : "arrival";
  const filter: ReservationListFilter = {
    q: one(sp.q), status: one(sp.status) || undefined, roomTypeId: one(sp.roomTypeId) || undefined, source: one(sp.source) || undefined,
    roomId: one(sp.roomId) || undefined, arrivalFrom: one(sp.arrivalFrom), arrivalTo: one(sp.arrivalTo),
    departureFrom: one(sp.departureFrom), departureTo: one(sp.departureTo),
    payment: (["UNPAID", "PARTIAL", "PAID"] as const).find((p) => p === one(sp.payment)),
    sort, dir: one(sp.dir) === "desc" ? "desc" : "asc", page: Number(one(sp.page)) || 1,
  };
  const [res, types, rooms] = await Promise.all([listReservationsPage(db, ctx, filter), listRoomTypes(db, ctx), listRooms(db, ctx)]);

  const active: [string, string][] = Object.entries(filter).filter(([k, v]) => v && !["sort", "dir", "page"].includes(k)).map(([k, v]) => [k, String(v)]);
  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...Object.fromEntries(active), sort, dir: filter.dir, ...over })) if (v !== undefined && String(v) !== "") p.set(k, String(v));
    return `/app/reservations?${p}`;
  };
  const from = res.total === 0 ? 0 : (res.page - 1) * res.pageSize + 1;
  const to = Math.min(res.total, res.page * res.pageSize);

  return (
    <>
      <PageHeader
        title="Reservations"
        subtitle="Search, filter and manage every booking. Amounts are in rupees and include tax."
        actions={<>
          <Link href="/app/reservations/calendar" className={btnGhost}>Calendar</Link>
          {can("reservations.create") && <Link href="/app/reservations/new" className={btn}>New reservation</Link>}
        </>}
      />
      <Card title="Search and filters">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filter reservations">
          <label className="block space-y-1 sm:col-span-2"><span className="text-sm font-medium text-slate-700">Search</span>
            <input name="q" defaultValue={filter.q} placeholder="Reference, guest, mobile, email or OTA ref" className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Status</span>
            <select name="status" defaultValue={filter.status ?? ""} className={input}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}</select></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Room category</span>
            <select name="roomTypeId" defaultValue={filter.roomTypeId ?? ""} className={input}><option value="">Any category</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Booking source</span>
            <select name="source" defaultValue={filter.source ?? ""} className={input}><option value="">Any source</option>{BOOKING_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}</select></label>
          {res.canMoney && (
            <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Payment status</span>
              <select name="payment" defaultValue={filter.payment ?? ""} className={input}><option value="">Any payment status</option>{PAYMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          )}
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Assigned room</span>
            <select name="roomId" defaultValue={filter.roomId ?? ""} className={input}><option value="">Any room</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Arrival from</span><input type="date" name="arrivalFrom" defaultValue={filter.arrivalFrom} className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Arrival to</span><input type="date" name="arrivalTo" defaultValue={filter.arrivalTo} className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Departure from</span><input type="date" name="departureFrom" defaultValue={filter.departureFrom} className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Departure to</span><input type="date" name="departureTo" defaultValue={filter.departureTo} className={input} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Sort by</span>
            <select name="sort" defaultValue={sort} className={input}>{RESERVATION_SORTS.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}</select></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Order</span>
            <select name="dir" defaultValue={filter.dir} className={input}><option value="asc">Oldest first</option><option value="desc">Newest first</option></select></label>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <button className={btn}>Apply</button>
            {active.length > 0 && <Link href="/app/reservations" className={btnGhost}>Clear filters</Link>}
          </div>
        </form>
      </Card>

      <div className="mt-4">
        <Card title={`Reservations (${res.total})`}>
          {res.items.length === 0 ? (
            <EmptyState title={active.length ? "No reservations match these filters" : "No reservations yet"}>
              {active.length ? "Widen the dates or clear the filters." : "Make the first booking from New reservation."}
            </EmptyState>
          ) : (
            <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Reservations table, scrolls sideways">
              <table className="w-full min-w-[72rem] text-left text-sm">
                <thead className="text-xs text-slate-600">
                  <tr>
                    <th scope="col" className="py-1 pr-2">Reference</th><th scope="col" className="pr-2">Guest</th><th scope="col" className="pr-2">Stay</th>
                    <th scope="col" className="pr-2">Nts</th><th scope="col" className="pr-2">Guests</th><th scope="col" className="pr-2">Room</th>
                    <th scope="col" className="pr-2">Source</th><th scope="col" className="pr-2">Status</th>
                    {res.canMoney && <><th scope="col" className="pr-2 text-right">Total</th><th scope="col" className="pr-2 text-right">Paid</th><th scope="col" className="pr-2 text-right">Balance</th></>}
                    <th scope="col" className="pr-2">Booked</th><th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {res.items.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="py-2 pr-2 font-mono text-xs">
                        <Link className="underline" href={`/app/reservations/${r.id}`}>{r.reference}</Link>
                        {r.externalRef && <span className="block text-slate-600">OTA {r.externalRef}</span>}
                      </td>
                      <td className="pr-2">
                        {r.guest.name}{r.vip && <span className="ml-1 rounded-full bg-gold-100 px-1.5 text-xs text-gold-700">VIP</span>}
                        <span className="block text-xs text-slate-600">{[r.guest.phone, r.guest.email].filter(Boolean).join(" · ") || "No contact"}</span>
                      </td>
                      <td className="whitespace-nowrap pr-2">{fmtDate(r.arrival)} → {fmtDate(r.departure)}</td>
                      <td className="pr-2 tabular-nums">{r.nights}</td>
                      <td className="whitespace-nowrap pr-2">{r.adults}A{r.children ? ` ${r.children}C` : ""}</td>
                      <td className="pr-2">{r.room ?? <span className="text-slate-600">Unassigned</span>}<span className="block text-xs text-slate-600">{r.roomType}</span></td>
                      <td className="pr-2">{SOURCE_LABELS[r.source as keyof typeof SOURCE_LABELS] ?? r.source}</td>
                      <td className="pr-2"><Badge value={r.status} /></td>
                      {res.canMoney && r.money && (
                        <>
                          <td className="pr-2 text-right tabular-nums">{inr(r.money.totalMinor)}{r.money.estimated && <span className="block text-xs text-slate-600">estimate</span>}</td>
                          <td className="pr-2 text-right tabular-nums">{inr(r.money.paidMinor)}</td>
                          <td className="pr-2 text-right tabular-nums"><span className={r.money.balanceMinor > 0 ? "font-medium text-amber-900" : ""}>{inr(r.money.balanceMinor)}</span>
                            <span className="block text-xs text-slate-600">{r.money.payment === "PAID" ? "paid" : r.money.payment === "PARTIAL" ? "part paid" : "unpaid"}</span></td>
                        </>
                      )}
                      <td className="whitespace-nowrap pr-2 text-xs text-slate-600">{fmtDate(r.createdAt)}<span className="block">{r.createdBy}</span></td>
                      <td><ReservationActions id={r.id} status={r.status} ctx={ctx} back={href({})} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {res.total > 0 && (
            <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-slate-600">Showing {from}–{to} of {res.total}</span>
              <span className="flex gap-2">
                {res.page > 1 ? <Link className={btnGhost} href={href({ page: res.page - 1 })}>Previous</Link> : <span className={`${btnGhost} opacity-50`} aria-disabled="true">Previous</span>}
                <span className="px-1 py-1.5">Page {res.page} of {res.pages}</span>
                {res.page < res.pages ? <Link className={btnGhost} href={href({ page: res.page + 1 })}>Next</Link> : <span className={`${btnGhost} opacity-50`} aria-disabled="true">Next</span>}
              </span>
            </nav>
          )}
        </Card>
      </div>
    </>
  );
}
