import { Card, ErrorBanner, fmtDate, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listReservations } from "@/server/services/reservations";
import { ReservationActions } from "../ReservationActions";

export default async function FrontDesk({ searchParams }: PageProps<"/app/front-desk">) {
  const { error } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const today = fmtDate(new Date());
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
