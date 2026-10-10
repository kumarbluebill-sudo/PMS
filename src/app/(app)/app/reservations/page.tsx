import { addReservationAction } from "@/app/actions";
import { Badge, btn, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRoomTypes } from "@/server/services/rooms";
import { searchGuests } from "@/server/services/guests";
import { listReservations } from "@/server/services/reservations";
import { ReservationActions } from "../ReservationActions";

export default async function Reservations({ searchParams }: PageProps<"/app/reservations">) {
  const { error } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const [list, types, guests] = await Promise.all([
    listReservations(db, ctx),
    listRoomTypes(db, ctx),
    searchGuests(db, ctx),
  ]);
  const today = fmtDate(new Date());
  return (
    <>
      <PageHeader title="Reservations" subtitle="Dates are nights: the departure date is not an occupied night." />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="New reservation">
          <form action={addReservationAction} className="space-y-3">
            <Field label="Guest">
              <select name="guestId" required className={input}>
                {guests.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            <Field label="Room type">
              <select name="roomTypeId" required className={input}>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Arrival"><input name="arrival" type="date" min={today} required className={input} /></Field>
              <Field label="Departure"><input name="departure" type="date" min={today} required className={input} /></Field>
              <Field label="Adults"><input name="adults" type="number" min={1} defaultValue={1} className={input} /></Field>
              <Field label="Children"><input name="children" type="number" min={0} defaultValue={0} className={input} /></Field>
            </div>
            <Field label="Source">
              <select name="source" className={input}>
                {["DIRECT", "WALK_IN", "PHONE", "EMAIL", "AGENT", "CORPORATE"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <button className={btn} disabled={!guests.length || !types.length}>Book</button>
            {(!guests.length || !types.length) && <p className="text-xs text-slate-500">Add a guest and a room type first.</p>}
          </form>
        </Card>
        <div className="lg:col-span-2">
          <Card title={`Reservations (${list.length})`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr><th className="py-1">Ref</th><th>Guest</th><th>Room</th><th>Stay</th><th>Status</th><th /></tr>
                </thead>
                <tbody className="divide-y">
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 font-mono text-xs">{r.reference}</td>
                      <td>{r.guest.name}</td>
                      <td>{r.assignments[0]?.room.number ?? "—"}</td>
                      <td>{fmtDate(r.arrival)} → {fmtDate(r.departure)}</td>
                      <td><Badge value={r.status} /></td>
                      <td><ReservationActions id={r.id} status={r.status} ctx={ctx} back="/app/reservations" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
