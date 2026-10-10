import Link from "next/link";
import { Card, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { listPayments } from "@/server/services/payments";

export default async function Payments() {
  const rows = await listPayments(getDb(), await getCtx());
  return (
    <>
      <PageHeader title="Payments" subtitle="Payments recorded by staff. Online-gateway payments will appear here once gateway confirmation is connected." />
      <Card>
        {rows.length === 0 ? <p className="text-sm text-slate-500">No payments yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500"><tr><th className="py-1">Received (UTC)</th><th>Guest</th><th>Method</th><th>Reference</th><th className="text-right">Amount</th></tr></thead>
              <tbody className="divide-y">
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2 whitespace-nowrap">{p.receivedAt.toISOString().replace("T", " ").slice(0, 16)}</td>
                    <td><Link className="underline" href={`/app/guest-folios/${p.folioId}`}>{p.folio.reservation.guest.name}</Link></td>
                    <td>{p.method}</td>
                    <td>{p.reference ?? ""}</td>
                    <td className="text-right font-mono">{formatInr(p.amountMinor)}</td>
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
