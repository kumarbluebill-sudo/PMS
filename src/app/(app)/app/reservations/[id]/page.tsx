import Link from "next/link";
import { extendStayAction, moveRoomAction } from "@/app/account-actions";
import { changeCategoryAction, modifyReservationAction } from "@/app/reservation-actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, inr, PageHeader } from "@/app/ui";
import { previewCategoryChange, previewModification, reservationChecklist } from "@/server/services/confirmation";
import { listRoomTypes } from "@/server/services/rooms";
import { AppError } from "@/server/errors";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRooms } from "@/server/services/rooms";
import { getReservation, reservationTimeline } from "@/server/services/reservations";
import ReservationMessages from "../../messages/ReservationMessages";
import ReservationEmail from "../../messages/ReservationEmail";
import { listReservationEmails, emailStatus } from "@/server/services/emailOutbox";
import { getConsent, messagingStatus } from "@/server/services/messaging";
import { FeedbackLinkButton } from "../../FeedbackLinkButton";
import { ReservationActions } from "../../ReservationActions";

export default async function StayDetail({ params, searchParams }: PageProps<"/app/reservations/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { error, ok } = sp;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  const ctx = await getCtx();
  const db = getDb();
  const [r, timeline] = await Promise.all([getReservation(db, ctx, id), reservationTimeline(db, ctx, id)]);
  const canModify = roleHasPermission(ctx.role, "reservations.modify", ctx.extra) && (r.status === "CONFIRMED" || r.status === "CHECKED_IN");
  const rooms = canModify ? await listRooms(db, ctx) : [];
  const canChange = roleHasPermission(ctx.role, "reservations.modify", ctx.extra) && (r.status === "TENTATIVE" || r.status === "CONFIRMED");
  const checklist = r.status === "TENTATIVE" ? await reservationChecklist(db, ctx, id) : null;
  const mod = { arrival: one(sp.m_arrival) || fmtDate(r.arrival), departure: one(sp.m_departure) || fmtDate(r.departure), adults: one(sp.m_adults) || String(r.adults), children: one(sp.m_children) || String(r.children) };
  const types = canChange ? (await listRoomTypes(db, ctx)).filter((t) => t.id !== r.roomTypeId) : [];
  const catId = canChange ? one(sp.c_type) : "";
  let catPreview: Awaited<ReturnType<typeof previewCategoryChange>> | null = null;
  let catError: string | null = null;
  if (catId) {
    try { catPreview = await previewCategoryChange(db, ctx, id, { roomTypeId: catId, roomId: one(sp.c_room) || undefined, reason: "preview" }); }
    catch (e) { catError = e instanceof AppError ? e.message : "Check the category."; }
  }
  const wantsPreview = canChange && !!one(sp.m_arrival);
  let preview: Awaited<ReturnType<typeof previewModification>> | null = null;
  let previewError: string | null = null;
  if (wantsPreview) {
    try { preview = await previewModification(db, ctx, id, { arrival: mod.arrival, departure: mod.departure, adults: Number(mod.adults), children: Number(mod.children) }); }
    catch (e) { previewError = e instanceof AppError ? e.message : "Check the dates and guest numbers."; }
  }
  const back = `/app/reservations/${r.id}`;
  const canMessage = roleHasPermission(ctx.role, "guests.manage", ctx.extra);
  const consent = canMessage ? await getConsent(db, ctx, r.guestId) : null;
  const emailConsent = canMessage ? await getConsent(db, ctx, r.guestId, "EMAIL") : null;
  const emails = canMessage ? await listReservationEmails(db, ctx, r.id) : [];
  const room = r.assignments.find((a) => a.active)?.room ?? r.assignments.at(-1)?.room;
  return (
    <>
      <PageHeader title={`Stay ${r.reference}`} subtitle={`${r.guest.name} · ${fmtDate(r.arrival)} → ${fmtDate(r.departure)}`} />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{ok}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Reservation">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Status</dt><dd><Badge value={r.status} /></dd>
            <dt className="text-slate-500">Room</dt><dd>{room ? `${room.number} (${room.roomType.name})` : "—"}</dd>
            <dt className="text-slate-500">Guests</dt><dd>{r.adults} adult(s), {r.children} child(ren)</dd>
            <dt className="text-slate-500">Source</dt><dd>{r.source}{r.externalRef ? ` · OTA ref ${r.externalRef}` : ""}</dd>
            <dt className="text-slate-500">Guest</dt><dd>{r.guest.name}{r.guest.phone ? ` · ${r.guest.phone}` : ""}{r.guest.email ? ` · ${r.guest.email}` : ""}{roleHasPermission(ctx.role, "guests.view", ctx.extra) && <Link href={`/app/guests/${r.guestId}`} className="ml-2 text-xs underline">Guest profile and history</Link>}</dd>
            {r.notes && (<><dt className="text-slate-500">Requests for this stay</dt><dd>{r.notes}</dd></>)}
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ReservationActions id={r.id} status={r.status} ctx={ctx} back={back} />
            <Link href="/app/dashboard" className={btnGhost}>Back to room board</Link>
          </div>
        </Card>
        <Card title="Change history">
          <ol className="space-y-2 text-sm">
            {timeline.map((t, i) => (
              <li key={i}>
                <span className="font-medium text-slate-900">{t.what}</span>
                <span className="block text-xs text-slate-600">{t.at.toISOString().slice(0, 16).replace("T", " ")} UTC · {t.by}{t.detail ? ` · ${t.detail}` : ""}</span>
                {t.reason && <span className="block text-xs text-slate-700">Reason: {t.reason}</span>}
              </li>
            ))}
            {timeline.length === 0 && <li className="text-slate-600">No changes recorded.</li>}
          </ol>
        </Card>
        {canMessage && (
          <ReservationMessages reservationId={r.id} guestId={r.guestId} back={back} consent={consent ? { status: consent.status, source: consent.source } : null} hasPhone={!!r.guest.phone} testMode={!messagingStatus().configured} />
        )}
        {canMessage && (
          <ReservationEmail reservationId={r.id} guestId={r.guestId} back={back} consent={emailConsent ? { status: emailConsent.status, source: emailConsent.source } : null} hasEmail={!!r.guest.email} testMode={!emailStatus().configured} emails={emails} />
        )}
        {roleHasPermission(ctx.role, "feedback.manage", ctx.extra) && (r.status === "CHECKED_IN" || r.status === "CHECKED_OUT") && (
          <Card title="Guest feedback">
            <p className="mb-2 text-sm text-slate-600">Create a private, single-use link the guest can open without logging in.</p>
            <FeedbackLinkButton reservationId={r.id} />
          </Card>
        )}
        {checklist && (
          <Card title="Before you confirm">
            <ul className="space-y-1.5 text-sm" aria-label="Confirmation checklist">
              {checklist.items.map((i) => (
                <li key={i.key} className="flex items-start gap-2">
                  <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${i.ok ? "bg-green-100 text-green-800" : i.level === "BLOCKER" ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900"}`}>{i.ok ? "✓" : i.level === "BLOCKER" ? "✕" : "!"}</span>
                  <span><span className="font-medium">{i.label}</span><span className="sr-only">{i.ok ? " (ready)" : i.level === "BLOCKER" ? " (must fix)" : " (check)"}</span><span className="block text-xs text-slate-700">{i.detail}</span></span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-700">{checklist.canConfirm ? "Nothing blocks confirming. Items marked ! are worth a look but do not stop you." : "Fix the items marked ✕ before confirming."}</p>
          </Card>
        )}
        {canChange && (
          <Card title="Change dates or guests">
            <p className="mb-2 text-xs text-slate-700">Preview the new price, then save. Prices follow your property&rsquo;s setting: keep the booked rates, or use today&rsquo;s. The change is recorded with who made it.</p>
            <form method="get" className="grid grid-cols-2 gap-2">
              <Field label="New check-in"><input type="date" name="m_arrival" defaultValue={mod.arrival} required className={input} /></Field>
              <Field label="New check-out"><input type="date" name="m_departure" defaultValue={mod.departure} required className={input} /></Field>
              <Field label="Adults"><input type="number" name="m_adults" min={1} defaultValue={mod.adults} className={input} /></Field>
              <Field label="Children"><input type="number" name="m_children" min={0} defaultValue={mod.children} className={input} /></Field>
              <div className="col-span-2"><button className={btnGhost}>Preview change</button></div>
            </form>
            {previewError && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">{previewError}</p>}
            {preview && (
              <div className="mt-3 space-y-2 border-t pt-3 text-sm" role="status">
                {preview.canSeeMoney ? (
                  <p>{preview.nights} night(s). Total was <strong>{inr(preview.oldTotalMinor)}</strong>, becomes <strong>{inr(preview.newTotalMinor)}</strong> ({preview.differenceMinor >= 0 ? "+" : ""}{inr(preview.differenceMinor)}), tax included. Pricing: {preview.policy === "KEEP_RATE" ? "booked rates kept" : "today's rates"}.</p>
                ) : <p>{preview.nights} night(s). Pricing: {preview.policy === "KEEP_RATE" ? "booked rates kept" : "today's rates"}.</p>}
                <form action={modifyReservationAction} className="space-y-2">
                  <input type="hidden" name="id" value={r.id} /><input type="hidden" name="expectedUpdatedAt" value={r.updatedAt.toISOString()} />
                  <input type="hidden" name="arrival" value={mod.arrival} /><input type="hidden" name="departure" value={mod.departure} />
                  <input type="hidden" name="adults" value={mod.adults} /><input type="hidden" name="children" value={mod.children} /><input type="hidden" name="previewTotal" value={preview.newTotalMinor} />
                  <Field label="Reason for the change (optional)"><input name="reason" maxLength={200} className={input} /></Field>
                  <button className={btn}>Save change</button>
                </form>
              </div>
            )}
          </Card>
        )}
        {canChange && types.length > 0 && (
          <Card title="Change room category">
            <p className="mb-2 text-xs text-slate-700">Moves the booking to a free room of another category and prices the stay at that category&rsquo;s current rates. Any discount on the old booking is not carried over.</p>
            <form method="get" className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <Field label="New category"><select name="c_type" defaultValue={catId} className={input}><option value="">Choose a category</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
              <div className="flex items-end"><button className={btnGhost}>Check room and price</button></div>
            </form>
            {catError && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">{catError}</p>}
            {catPreview && (
              <div className="mt-3 space-y-2 border-t pt-3 text-sm" role="status">
                <p>{catPreview.from} to <strong>{catPreview.to}</strong>, room <strong>{catPreview.room}</strong> ({catPreview.nights} night(s)).{catPreview.canSeeMoney && <> Total was <strong>{inr(catPreview.oldTotalMinor)}</strong>, becomes <strong>{inr(catPreview.newTotalMinor)}</strong> ({catPreview.differenceMinor >= 0 ? "+" : ""}{inr(catPreview.differenceMinor)}).</>}{catPreview.discountDropped && " The earlier discount is not carried over."}</p>
                <form action={changeCategoryAction} className="space-y-2">
                  <input type="hidden" name="id" value={r.id} /><input type="hidden" name="roomTypeId" value={catId} /><input type="hidden" name="expectedUpdatedAt" value={r.updatedAt.toISOString()} />
                  <Field label="Room"><select name="roomId" defaultValue={one(sp.c_room) || catPreview.freeRooms[0]?.id} className={input}>{catPreview.freeRooms.map((x) => <option key={x.id} value={x.id}>{x.number}</option>)}</select></Field>
                  <Field label="Reason for the change"><input name="reason" required minLength={3} maxLength={200} className={input} /></Field>
                  <button className={btn}>Change category</button>
                </form>
              </div>
            )}
          </Card>
        )}
        {canModify && (
          <Card title="Change stay">
            <form action={extendStayAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="back" value={back} />
              <input type="date" name="departure" required defaultValue={fmtDate(r.departure)} className="rounded border border-slate-300 p-1 text-sm" aria-label="New departure date" />
              <button className={btnGhost}>Extend / change departure</button>
            </form>
            <form action={moveRoomAction} className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="back" value={back} />
              <select name="roomId" className="rounded border border-slate-300 p-1 text-sm" aria-label="New room">
                {rooms.map((x) => <option key={x.id} value={x.id}>{x.number} · {x.roomType.name}</option>)}
              </select>
              <input name="reason" required placeholder="Reason" className="rounded border border-slate-300 p-1 text-sm" />
              <button className={btnGhost}>Change room</button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
