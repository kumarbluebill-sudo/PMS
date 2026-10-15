import Link from "next/link";
import { extendStayAction, moveRoomAction } from "@/app/account-actions";
import { Badge, btnGhost, Card, ErrorBanner, fmtDate, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRooms } from "@/server/services/rooms";
import { getReservation, reservationTimeline } from "@/server/services/reservations";
import ReservationMessages from "../../messages/ReservationMessages";
import { getConsent, messagingStatus } from "@/server/services/messaging";
import { FeedbackLinkButton } from "../../FeedbackLinkButton";
import { ReservationActions } from "../../ReservationActions";

export default async function StayDetail({ params, searchParams }: PageProps<"/app/reservations/[id]">) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const [r, timeline] = await Promise.all([getReservation(db, ctx, id), reservationTimeline(db, ctx, id)]);
  const canModify = roleHasPermission(ctx.role, "reservations.modify", ctx.extra) && (r.status === "CONFIRMED" || r.status === "CHECKED_IN");
  const rooms = canModify ? await listRooms(db, ctx) : [];
  const back = `/app/reservations/${r.id}`;
  const canMessage = roleHasPermission(ctx.role, "guests.manage", ctx.extra);
  const consent = canMessage ? await getConsent(db, ctx, r.guestId) : null;
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
            <dt className="text-slate-500">Guest</dt><dd>{r.guest.name}{r.guest.phone ? ` · ${r.guest.phone}` : ""}{r.guest.email ? ` · ${r.guest.email}` : ""}</dd>
            {r.notes && (<><dt className="text-slate-500">Notes</dt><dd>{r.notes}</dd></>)}
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
        {roleHasPermission(ctx.role, "feedback.manage", ctx.extra) && (r.status === "CHECKED_IN" || r.status === "CHECKED_OUT") && (
          <Card title="Guest feedback">
            <p className="mb-2 text-sm text-slate-600">Create a private, single-use link the guest can open without logging in.</p>
            <FeedbackLinkButton reservationId={r.id} />
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
