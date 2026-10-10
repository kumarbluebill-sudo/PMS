import { extendStayAction, moveRoomAction } from "@/app/account-actions";
import { btnGhost, Card, ErrorBanner, fmtDate, PageHeader } from "@/app/ui";
import { listRooms } from "@/server/services/rooms";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listReservations } from "@/server/services/reservations";
import { ReservationActions } from "../ReservationActions";

export default async function FrontDesk({ searchParams }: PageProps<"/app/front-desk">) {
  const { error } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const today = fmtDate(new Date());
  const rooms = await listRooms(db, ctx);
  const canModify = roleHasPermission(ctx.role, "reservations.modify", ctx.extra);
  const [arrivals, departures, inHouse] = await Promise.all([
    listReservations(db, ctx, { status: "CONFIRMED", arrivalOn: today }),
    listReservations(db, ctx, { status: "CHECKED_IN", departureOn: today }),
    listReservations(db, ctx, { status: "CHECKED_IN" }),
  ]);
  const section = (title: string, rows: typeof arrivals) => (
    <Card title={`${title} (${rows.length})`}>
      {rows.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
        <ul className="divide-y text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {r.guest.name} <span className="text-slate-500">Room {r.assignments[0]?.room.number ?? "—"}</span>
              </span>
              <ReservationActions id={r.id} status={r.status} ctx={ctx} back="/app/front-desk" />
              {canModify && (r.status === "CONFIRMED" || r.status === "CHECKED_IN") && (
                <details className="w-full text-xs">
                  <summary className="cursor-pointer text-slate-600">Extend / move</summary>
                  <form action={extendStayAction} className="mt-1 flex gap-1">
                    <input type="hidden" name="id" value={r.id} />
                    <input type="date" name="departure" required defaultValue={fmtDate(r.departure)} className="rounded border p-1" aria-label="New departure date" />
                    <button className={btnGhost}>Change departure</button>
                  </form>
                  <form action={moveRoomAction} className="mt-1 flex flex-wrap gap-1">
                    <input type="hidden" name="id" value={r.id} />
                    <select name="roomId" className="rounded border p-1" aria-label="New room">
                      {rooms.map((x) => <option key={x.id} value={x.id}>{x.number}</option>)}
                    </select>
                    <input name="reason" required placeholder="Reason" className="rounded border p-1" />
                    <button className={btnGhost}>Move room</button>
                  </form>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
  return (
    <>
      <PageHeader title="Front desk" subtitle={`Today: ${today}`} />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <p className="mb-3 text-xs text-slate-500">
        Check-out does not yet verify folio balances; billing arrives in the next phase.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {section("Arrivals", arrivals)}
        {section("Departures", departures)}
        {section("In house", inHouse)}
      </div>
    </>
  );
}
