import Link from "next/link";
import { Card, fmtDate, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { listInvoices } from "@/server/services/invoicing";

export default async function Invoices() {
  const rows = await listInvoices(getDb(), await getCtx(), ["TAX_INVOICE", "BILL_OF_SUPPLY"]);
  return (
    <>
      <PageHeader title="Invoices" subtitle="Issued invoices are immutable. Corrections are made with credit notes." />
      <Card>
        {rows.length === 0 ? <p className="text-sm text-slate-500">No invoices issued yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500"><tr><th className="py-1">Number</th><th>Date</th><th>Type</th><th className="text-right">GST</th><th className="text-right">Total</th></tr></thead>
              <tbody className="divide-y">
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2"><Link className="underline" href={`/app/invoices/${i.id}`}>{i.number}</Link></td>
                    <td>{fmtDate(i.issuedAt)}</td>
                    <td className="text-xs">{i.kind.replaceAll("_", " ").toLowerCase()}</td>
                    <td className="text-right font-mono">{formatInr(i.cgstMinor + i.sgstMinor + i.igstMinor + i.cessMinor)}</td>
                    <td className="text-right font-mono">{formatInr(i.grossMinor)}</td>
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
