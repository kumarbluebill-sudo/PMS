import Link from "next/link";
import { PageHeader, fmtDate } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { calendar } from "@/server/services/stays";

const DAY = 86_400_000;

export default async function CalendarPage({ searchParams }: PageProps<"/app/reservations/calendar">) {
  const { start } = await searchParams;
  const startDay = typeof start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : fmtDate(new Date());
  const ctx = await getCtx();
  const { rooms, assignments, from, days } = await calendar(getDb(), ctx, startDay, 14);
  const dates = Array.from({ length: days }, (_, i) => new Date(from.getTime() + i * DAY));
  const shift = (n: number) => fmtDate(new Date(from.getTime() + n * DAY));
  const cell = (roomId: string, d: Date) =>
    assignments.find((a) => a.roomId === roomId && a.arrival <= d && a.departure > d);
  return (
    <>
      <PageHeader title="Reservation calendar" subtitle="Each cell is a night; checkout day is free." />
      <div className="mb-3 flex gap-3 text-sm">
        <Link className="underline" href={`?start=${shift(-7)}`}>← Previous week</Link>
        <Link className="underline" href={`?start=${fmtDate(new Date())}`}>Today</Link>
        <Link className="underline" href={`?start=${shift(7)}`}>Next week →</Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-white p-2 text-left">Room</th>
              {dates.map((d) => (
                <th key={d.toISOString()} className="min-w-16 p-1 font-medium text-slate-600">
                  {d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="sticky left-0 bg-white p-2 font-medium">{r.number} <span className="font-normal text-slate-500">{r.roomType.name}</span></td>
                {dates.map((d) => {
                  const a = cell(r.id, d);
                  return (
                    <td
                      key={d.toISOString()}
                      title={a ? `${a.reservation.guest.name} (${a.reservation.status.toLowerCase()})` : r.outOfOrder ? "Out of order" : "Free"}
                      className={`border-l p-1 text-center ${a ? (a.reservation.status === "CHECKED_IN" ? "bg-green-100" : "bg-blue-100") : r.outOfOrder ? "bg-slate-200" : ""}`}
                    >
                      {a ? a.reservation.guest.name.split(" ")[0] : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">Blue = confirmed, green = in house, grey = out of order.</p>
    </>
  );
}
