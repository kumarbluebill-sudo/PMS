import Link from "next/link";
import { addBookingAction } from "@/app/actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, fmtDate, inr, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { BOOKING_SOURCES, SOURCE_LABELS } from "@/server/domain/quote";
import { getCtx } from "@/server/session";
import { availabilityByType, quoteStay, ID_TYPES, type Quote } from "@/server/services/booking";
import { listRoomTypes } from "@/server/services/rooms";
import { searchGuests } from "@/server/services/guests";
import { listReservations } from "@/server/services/reservations";
import { propertyToday } from "@/server/services/roomBlocks";
import { settingsFor } from "@/server/services/settings";
import { ReservationActions } from "../ReservationActions";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async function Reservations({ searchParams }: PageProps<"/app/reservations">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const st = await settingsFor(db, ctx);
  const [list, types, guests, today] = await Promise.all([
    listReservations(db, ctx),
    listRoomTypes(db, ctx),
    can("guests.view") ? searchGuests(db, ctx) : Promise.resolve([]),
    propertyToday(db, ctx),
  ]);

  const v = {
    roomTypeId: one(sp.roomTypeId) || types[0]?.id || "",
    roomId: one(sp.roomId),
    arrival: DAY.test(one(sp.arrival)) ? one(sp.arrival) : today,
    departure: DAY.test(one(sp.departure)) ? one(sp.departure) : "",
    rooms: one(sp.rooms) || "1",
    adults: one(sp.adults) || "1",
    children: one(sp.children) || "0",
    discountPct: one(sp.discountPct),
    discountAmt: one(sp.discountAmt),
  };

  // Step 2: availability and price, computed on the server from the saved rates and tax rules.
  let quote: Quote | null = null;
  let byType: Awaited<ReturnType<typeof availabilityByType>> = [];
  let quoteError: string | null = null;
  if (one(sp.check) && v.departure && v.roomTypeId) {
    try {
      byType = await availabilityByType(db, ctx, v.arrival, v.departure);
      const pct = v.discountPct.trim() ? Math.round(Number(v.discountPct) * 100) : undefined;
      const amtMatch = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(v.discountAmt.trim());
      quote = await quoteStay(db, ctx, {
        roomTypeId: v.roomTypeId, arrival: v.arrival, departure: v.departure,
        rooms: Number(v.rooms) || 1, adults: Number(v.adults) || 1, children: Number(v.children) || 0,
        ...(pct && Number.isFinite(pct) ? { discountPercentBp: pct } : {}),
        ...(amtMatch ? { discountAmountMinor: Number(amtMatch[1]) * 100 + Number((amtMatch[2] ?? "").padEnd(2, "0") || "0") } : {}),
      });
    } catch (e) {
      quoteError = e instanceof AppError ? e.message : "Check the dates and numbers entered.";
    }
  }
  const discounted = !!quote && quote.discountPerNightMinor > 0;
  const canBook = !!quote && quote.available >= quote.rooms && can("reservations.create");

  return (
    <>
      <PageHeader title="Reservations" subtitle="Check availability, review the price, then save. Check-out day is not a night." />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : quoteError ?? undefined} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4">
          <Card title="1. Dates and rooms">
            <form method="get" className="space-y-3">
              <input type="hidden" name="check" value="1" />
              {v.roomId && <input type="hidden" name="roomId" value={v.roomId} />}
              <div className="grid grid-cols-2 gap-2">
                <Field label="Check-in"><input name="arrival" type="date" min={today} defaultValue={v.arrival} required className={input} /></Field>
                <Field label="Check-out"><input name="departure" type="date" min={today} defaultValue={v.departure} required className={input} /></Field>
              </div>
              <Field label="Room type">
                <select name="roomTypeId" defaultValue={v.roomTypeId} required className={input}>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Rooms"><input name="rooms" type="number" min={1} max={20} defaultValue={v.rooms} className={input} /></Field>
                <Field label="Adults"><input name="adults" type="number" min={1} defaultValue={v.adults} className={input} /></Field>
                <Field label="Children"><input name="children" type="number" min={0} defaultValue={v.children} className={input} /></Field>
              </div>
              {can("billing.discount") && (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Discount %"><input name="discountPct" inputMode="decimal" defaultValue={v.discountPct} className={input} /></Field>
                  <Field label="or ₹ off per night"><input name="discountAmt" inputMode="decimal" defaultValue={v.discountAmt} className={input} /></Field>
                </div>
              )}
              {v.roomId && <p className="text-xs text-slate-600">A specific room was chosen on the room board; it will be used if it is free.</p>}
              <button className={btn} disabled={!types.length}>Check availability and price</button>
              {!types.length && <p className="text-xs text-slate-500">Add a room type first.</p>}
            </form>
          </Card>

          {quote && (
            <Card title="2. Availability and price">
              <p className={`mb-2 rounded px-2 py-1 text-sm font-medium ${quote.available >= quote.rooms ? "bg-green-50 text-green-900" : "bg-red-50 text-red-900"}`} role="status">
                {quote.available >= quote.rooms
                  ? `${quote.available} ${quote.roomType} room(s) available for ${quote.nights} night(s).`
                  : quote.available === 0
                    ? `No ${quote.roomType} room is available for those dates.`
                    : `Only ${quote.available} ${quote.roomType} room(s) available; you asked for ${quote.rooms}.`}
              </p>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                <dt>Rate per night{discounted ? " (after discount)" : ""}</dt><dd>{inr(quote.rateMinor)}</dd>
                {discounted && (<><dt className="text-slate-500">Base rate</dt><dd className="text-slate-500 line-through">{inr(quote.baseRateMinor)}</dd></>)}
                <dt>{quote.nights} night(s) × {quote.rooms} room(s)</dt><dd>{inr(quote.subtotalMinor)}</dd>
                <dt>{quote.taxStatus === "NOT_REGISTERED" ? "GST (not registered)" : "GST"}</dt><dd>{inr(quote.taxMinor)}</dd>
                <dt className="font-semibold">Estimated total</dt><dd className="font-semibold">{inr(quote.totalMinor)}</dd>
              </dl>
              {quote.taxNote && <p className="mt-2 text-xs text-slate-600">{quote.taxNote}</p>}
              {quote.depositRequiredMinor > 0 && <p className="mt-2 text-sm"><strong>Deposit requested:</strong> {inr(quote.depositRequiredMinor)} ({st["reservation.depositPercent"]}% of the estimate)</p>}
              <p className="mt-2 text-xs text-slate-500">This is an estimate. The final bill is built from the folio when the stay is posted. The server recalculates everything when you save.</p>
              {byType.length > 0 && (
                <table className="mt-3 w-full text-left text-xs">
                  <caption className="mb-1 text-left font-medium text-slate-700">Availability for these dates</caption>
                  <thead className="text-slate-500"><tr><th>Room type</th><th>Free</th><th>Rate</th></tr></thead>
                  <tbody>
                    {byType.map((t) => <tr key={t.id}><td>{t.name}</td><td>{t.available} of {t.totalRooms}</td><td>{inr(t.baseRateMinor)}</td></tr>)}
                  </tbody>
                </table>
              )}
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-2">
          {quote && canBook && (
            <Card title="3. Guest and booking details">
              <form action={addBookingAction} className="grid gap-3 md:grid-cols-2">
                {(["roomTypeId", "roomId", "arrival", "departure", "rooms", "adults", "children", "discountPct", "discountAmt"] as const).map((k) => (
                  <input key={k} type="hidden" name={k} value={v[k]} />
                ))}
                {can("guests.view") && guests.length > 0 && (
                  <Field label="Existing guest">
                    <select name="guestId" defaultValue="" className={input}>
                      <option value="">New guest (fill in below)</option>
                      {guests.map((g) => <option key={g.id} value={g.id}>{g.name}{g.phone ? ` · ${g.phone}` : ""}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Guest name"><input name="g_name" className={input} autoComplete="off" /></Field>
                <Field label="Mobile number"><input name="g_mobile" type="tel" inputMode="tel" className={input} autoComplete="off" /></Field>
                <Field label="Booking source">
                  <select name="source" defaultValue="WALK_IN" className={input}>
                    {BOOKING_SOURCES.filter((s) => st["reservation.enabledSources"].includes(s)).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
                  </select>
                </Field>
                <Field label="Booking status">
                  <select name="status" defaultValue="CONFIRMED" className={input}>
                    <option value="CONFIRMED">Confirmed</option>
                    <option value="TENTATIVE">Tentative (holds the room)</option>
                  </select>
                </Field>
                {discounted && (
                  <Field label="Reason for discount"><input name="discountReason" required minLength={3} className={input} /></Field>
                )}
                {can("payments.record") && (
                  <>
                    <Field label="Advance received (₹, optional)"><input name="advanceAmt" inputMode="decimal" className={input} /></Field>
                    <Field label="Advance method">
                      <select name="advanceMethod" defaultValue="UPI" className={input}>
                        {["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"].map((m) => <option key={m} value={m}>{m.replace("_", " ").toLowerCase()}</option>)}
                      </select>
                    </Field>
                    <Field label="Advance reference (optional)"><input name="advanceRef" className={input} /></Field>
                  </>
                )}
                <details className="md:col-span-2">
                  <summary className="cursor-pointer text-sm text-slate-600">More details (optional)</summary>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <Field label="Email"><input name="g_email" type="email" className={input} /></Field>
                    <Field label="Company"><input name="companyName" className={input} /></Field>
                    <Field label="Travel agent"><input name="agentName" className={input} /></Field>
                    <Field label="Guest address"><input name="g_address" className={input} /></Field>
                    <Field label="ID type (where legally required)">
                      <select name="g_idType" defaultValue="" className={input}>
                        <option value="">Not recorded</option>
                        {ID_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ").toLowerCase()}</option>)}
                      </select>
                    </Field>
                    <Field label="ID number"><input name="g_idNumber" autoComplete="off" className={input} /></Field>
                    <div className="md:col-span-2"><Field label="Special requests"><textarea name="notes" rows={2} className={input} /></Field></div>
                  </div>
                </details>
                <div className="md:col-span-2">
                  <button className={btn}>Save booking</button>
                  <span className="ml-3 text-xs text-slate-500">Rate plan: Standard (room type base rate).</span>
                </div>
              </form>
            </Card>
          )}

          <Card title={`Reservations (${list.length})`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr><th className="py-1">Ref</th><th>Guest</th><th>Room</th><th>Stay</th><th>Source</th><th>Status</th><th /></tr>
                </thead>
                <tbody className="divide-y">
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 font-mono text-xs"><Link className="underline" href={`/app/reservations/${r.id}`}>{r.reference}</Link></td>
                      <td>{r.guest.name}</td>
                      <td>{r.assignments[0]?.room.number ?? "—"}</td>
                      <td className="whitespace-nowrap">{fmtDate(r.arrival)} → {fmtDate(r.departure)}</td>
                      <td>{SOURCE_LABELS[r.source] ?? r.source}</td>
                      <td><Badge value={r.status} /></td>
                      <td><ReservationActions id={r.id} status={r.status} ctx={ctx} back="/app/reservations" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.length === 0 && <p className="py-3 text-sm text-slate-500">No reservations yet. Check availability above to make the first booking.</p>}
          </Card>
          <p className="text-xs text-slate-500"><Link href="/app/reservations/calendar" className={btnGhost}>Open calendar</Link></p>
        </div>
      </div>
    </>
  );
}
