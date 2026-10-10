import { getCtx } from "@/server/session";
import { getDb } from "@/server/db/client";
import { listReservations } from "@/server/services/reservations";
import { listRooms } from "@/server/services/rooms";
import { Card, PageHeader } from "@/app/ui";

export default async function Dashboard() {
  const ctx = await getCtx();
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const [rooms, arrivals, departures, inHouse] = await Promise.all([
    listRooms(db, ctx),
    listReservations(db, ctx, { status: "CONFIRMED", arrivalOn: today }),
    listReservations(db, ctx, { status: "CHECKED_IN", departureOn: today }),
    listReservations(db, ctx, { status: "CHECKED_IN" }),
  ]);
  const sellable = rooms.filter((r) => !r.outOfOrder).length;
  const occupied = inHouse.length;
  const stats = [
    ["Total rooms", rooms.length],
    ["Sellable rooms", sellable],
    ["Occupied now", occupied],
    ["Occupancy", sellable ? `${Math.round((occupied / sellable) * 100)}%` : "0%"],
    ["Arrivals today", arrivals.length],
    ["Departures today", departures.length],
    ["Dirty rooms", rooms.filter((r) => r.housekeeping === "DIRTY").length],
  ];
  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Operational snapshot for ${today}`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(([k, v]) => (
          <Card key={k as string}>
            <div className="text-xs text-slate-500">{k}</div>
            <div className="text-2xl font-semibold">{v}</div>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Occupancy here = rooms with a checked-in guest / sellable rooms right now. Revenue, ADR and RevPAR arrive with the billing phase.
      </p>
    </>
  );
}
