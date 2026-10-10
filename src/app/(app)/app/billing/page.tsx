import Link from "next/link";
import { Badge, Card, fmtDate, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { listFolios } from "@/server/services/billing";

export default async function Billing() {
  const folios = await listFolios(getDb(), await getCtx());
  return (
    <>
      <PageHeader title="Guest folios" subtitle="One folio per reservation. Balance = charges (with GST) minus payments, plus refunds." />
      <Card>
        {folios.length === 0 ? (
          <p className="text-sm text-slate-500">No folios yet. Open one from Front desk or Reservations.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr><th className="py-1">Guest</th><th>Stay</th><th>Status</th><th className="text-right">Balance</th><th /></tr>
              </thead>
              <tbody className="divide-y">
                {folios.map((f) => (
                  <tr key={f.id}>
                    <td className="py-2">{f.reservation.guest.name}</td>
                    <td>{fmtDate(f.reservation.arrival)} → {fmtDate(f.reservation.departure)}</td>
                    <td><Badge value={f.reservation.status} /></td>
                    <td className={`text-right font-mono ${f.balance > 0 ? "text-red-700" : ""}`}>{formatInr(f.balance)}</td>
                    <td className="text-right"><Link className="underline" href={`/app/guest-folios/${f.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
