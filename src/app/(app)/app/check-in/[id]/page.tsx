import Link from "next/link";
import { assignRoomAction, guardedCheckInAction, registrationAction, requestsAction, verifyIdAction } from "@/app/frontoffice-actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { SOURCE_LABELS } from "@/server/domain/quote";
import { roomReady as isReady, type CleanState } from "@/server/domain/housekeeping";
import { checkInContext } from "@/server/services/frontoffice";
import { getCtx } from "@/server/session";

const ID_TYPES = ["AADHAAR", "PASSPORT", "DRIVING_LICENCE", "VOTER_ID", "PAN", "OTHER"];

function Check({ ok, label, hint, optional }: { ok: boolean; label: string; hint?: string; optional?: boolean }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${ok ? "bg-green-100 text-green-800" : optional ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-900"}`}>{ok ? "✓" : optional ? "–" : "!"}</span>
      <span>
        <span className="font-medium text-slate-900">{label}</span>
        <span className="sr-only">{ok ? " (done)" : optional ? " (optional, not done)" : " (still to do)"}</span>
        {hint && <span className="block text-xs text-slate-600">{hint}</span>}
      </span>
    </li>
  );
}

export default async function CheckInPage({ params, searchParams }: PageProps<"/app/check-in/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCtx();
  const c = await checkInContext(getDb(), ctx, id);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const r = c.reservation;
  const live = r.status === "CONFIRMED";
  const hasRoom = !!c.room;
  const roomReady = !!c.room && isReady({ occupied: false, clean: c.room.housekeeping as CleanState, outOfOrder: c.room.outOfOrder, outOfService: false }, c.inspectionRequired);
  const blockers: string[] = [];
  if (!live) blockers.push(r.status === "CHECKED_IN" ? "This guest is already checked in." : `This reservation is ${r.status.replaceAll("_", " ").toLowerCase()}.`);
  if (live && c.arrivalIsFuture) blockers.push(`Arrival is on ${r.arrival}; check-in opens on the arrival date.`);
  if (live && !hasRoom) blockers.push("Assign a room.");
  if (live && hasRoom && !roomReady) blockers.push(`Room ${c.room!.number} is not ready (${c.room!.outOfOrder ? "out of order" : c.room!.housekeeping.toLowerCase()}).`);
  if (live && c.requireId && !r.idVerified) blockers.push("Verify the guest's ID.");

  return (
    <>
      <Breadcrumbs items={[{ label: "Today's operations", href: "/app/operations" }, { label: `Check-in ${r.reference}` }]} />
      <PageHeader title={`Check-in: ${c.guest.name}`} subtitle={`${r.reference} · ${fmtDate(new Date(r.arrival))} to ${fmtDate(new Date(r.departure))}`} actions={<Badge value={r.status} />} />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />
      {typeof sp.ok === "string" && <Notice tone="success">{sp.ok}</Notice>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card title="Reservation">
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-500">Reservation</dt><dd className="font-mono">{r.reference}</dd>
              <dt className="text-slate-500">Guest</dt><dd>{c.guest.name}{r.vip && <span className="ml-2 rounded-full bg-gold-100 px-2 py-0.5 text-xs font-medium text-gold-700">VIP</span>}</dd>
              <dt className="text-slate-500">Contact</dt><dd>{[c.guest.phone, c.guest.email].filter(Boolean).join(" · ") || "Not recorded"}</dd>
              <dt className="text-slate-500">Guests</dt><dd>{r.adults} adult(s), {r.children} child(ren)</dd>
              <dt className="text-slate-500">Room</dt><dd>{c.room ? `${c.room.number} (${c.room.type})` : `Not assigned · booked as ${r.roomTypeName}`}</dd>
              <dt className="text-slate-500">Source</dt><dd>{SOURCE_LABELS[r.source as keyof typeof SOURCE_LABELS] ?? r.source}</dd>
              <dt className="text-slate-500">Expected arrival</dt><dd>{r.etaTime ?? "Not given"}</dd>
              {r.earlyCheckinRequest && (<><dt className="text-slate-500">Early check-in</dt><dd>{r.earlyCheckinRequest}</dd></>)}
              {r.lateCheckoutRequest && (<><dt className="text-slate-500">Late checkout</dt><dd>{r.lateCheckoutRequest}</dd></>)}
              {r.notes && (<><dt className="text-slate-500">Special requests</dt><dd className="whitespace-pre-wrap">{r.notes}</dd></>)}
              {c.money && (
                <>
                  <dt className="text-slate-500">Advance paid</dt><dd>{inr(c.money.paidMinor)}</dd>
                  <dt className="text-slate-500">Outstanding</dt><dd className="font-medium">{inr(Math.max(0, c.money.balanceMinor))}</dd>
                </>
              )}
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={`/app/reservations/${r.id}`} className={btnGhost}>Open reservation</Link>
              {c.money?.folioId && <Link href={`/app/guest-folios/${c.money.folioId}`} className={btnGhost}>Open folio to record an advance</Link>}
            </div>
          </Card>

          {live && can("frontdesk.checkin") && (
            <Card title="Guest registration">
              <form action={registrationAction} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="reservationId" value={r.id} />
                <Field label="Mobile number"><input name="phone" inputMode="tel" placeholder={c.guest.hasPhone ? "On file (enter to replace)" : "10-digit mobile"} className={input} /></Field>
                <Field label="Email"><input name="email" type="email" className={input} /></Field>
                <Field label="ID type">
                  <select name="idType" defaultValue={c.guest.idType ?? ""} className={input}>
                    <option value="">Select</option>
                    {ID_TYPES.map((t) => <option key={t} value={t}>{t.replaceAll("_", " ").toLowerCase()}</option>)}
                  </select>
                </Field>
                <Field label="ID number"><input name="idNumber" autoComplete="off" placeholder={c.guest.idRecorded ? "On file (enter to replace)" : ""} className={input} /></Field>
                <Field label="Adults"><input name="adults" type="number" min={1} max={20} defaultValue={r.adults} className={input} /></Field>
                <Field label="Children"><input name="children" type="number" min={0} max={20} defaultValue={r.children} className={input} /></Field>
                <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                  <button className={btn}>Save registration</button>
                  <span className="text-xs text-slate-500">The ID number is stored encrypted and never shown again in full.</span>
                </div>
              </form>
              {c.guest.idRecorded && !r.idVerified && (
                <form action={verifyIdAction} className="mt-3 border-t pt-3">
                  <input type="hidden" name="reservationId" value={r.id} />
                  <button className={btnGhost}>I have seen the original ID: mark verified</button>
                </form>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Check-in checklist">
            <ul className="space-y-2.5">
              <Check ok={hasRoom} label="Room allocated" hint={c.room ? `Room ${c.room.number}` : "No room yet"} />
              <Check ok={!hasRoom || roomReady} label="Room ready" hint={c.room ? (roomReady ? (c.room.housekeeping === "INSPECTED" ? "Clean and inspected" : "Clean and available") : c.room.outOfOrder ? "Out of order" : c.room.housekeeping === "CLEAN" && c.inspectionRequired ? "Clean, waiting for inspection" : `Housekeeping: ${c.room.housekeeping.toLowerCase()}`) : "Needs a room first"} />
              <Check ok={c.guest.hasPhone} label="Mobile number on file" />
              <Check ok={c.guest.idRecorded} label="ID details recorded" />
              <Check ok={r.idVerified} label="ID verified" hint={c.requireId ? "Required by this property" : "Recommended"} />
              <Check ok={r.registrationComplete} label="Registration complete" />
              {c.money && <Check ok={c.money.paidMinor > 0} optional label="Advance payment" hint={c.money.paidMinor > 0 ? `${inr(c.money.paidMinor)} received` : "None received"} />}
            </ul>
            {blockers.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" aria-label="Before check-in">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            )}
            {can("frontdesk.checkin") && (
              <form action={guardedCheckInAction} className="mt-3">
                <input type="hidden" name="reservationId" value={r.id} />
                <button className={`${btn} w-full`} disabled={blockers.length > 0}>Complete check-in</button>
              </form>
            )}
          </Card>

          {live && can("reservations.modify") && (
            <Card title={hasRoom ? "Change room" : "Assign a room"}>
              <form action={assignRoomAction} className="space-y-2.5">
                <input type="hidden" name="reservationId" value={r.id} />
                <Field label="Available room">
                  <select name="roomId" required className={input}>
                    {c.freeRooms.length === 0 && <option value="">No rooms available for these dates</option>}
                    {c.freeRooms.map((x) => <option key={x.id} value={x.id}>{x.number} · {x.type}{isReady({ occupied: false, clean: x.housekeeping as CleanState, outOfOrder: false, outOfService: false }, c.inspectionRequired) ? "" : ` (${x.housekeeping.toLowerCase()}, not ready)`}</option>)}
                  </select>
                </Field>
                {hasRoom && <Field label="Reason for the change"><input name="reason" required maxLength={200} className={input} /></Field>}
                <button className={btnGhost} disabled={c.freeRooms.length === 0}>{hasRoom ? "Change room" : "Assign room"}</button>
              </form>
            </Card>
          )}

          {(live || r.status === "TENTATIVE") && can("reservations.modify") && (
            <Card title="Requests and VIP">
              <form action={requestsAction} className="space-y-2.5">
                <input type="hidden" name="reservationId" value={r.id} />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="vip" defaultChecked={r.vip} /> VIP guest</label>
                <Field label="Expected arrival time"><input name="etaTime" type="time" defaultValue={r.etaTime ?? ""} className={input} /></Field>
                <Field label="Early check-in request"><input name="early" defaultValue={r.earlyCheckinRequest ?? ""} placeholder="e.g. 10:00" maxLength={200} className={input} /></Field>
                <Field label="Late checkout request"><input name="late" defaultValue={r.lateCheckoutRequest ?? ""} placeholder="e.g. 15:00" maxLength={200} className={input} /></Field>
                <button className={btnGhost}>Save</button>
                <p className="text-xs text-slate-500">Requests are recorded for staff. Any fee is added manually on the folio.</p>
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
