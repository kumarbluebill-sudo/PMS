import Link from "next/link";
import { Card, fmtDate, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { listInvoices } from "@/server/services/invoicing";

export default async function CreditNotes() {
  const rows = await listInvoices(getDb(), await getCtx(), ["CREDIT_NOTE", "DEBIT_NOTE"]);
  return (
    <>
      <PageHeader title="Credit notes" subtitle="Raise a credit note from the invoice it corrects." />
      <Card>
        {rows.length === 0 ? <p className="text-sm text-slate-500">No credit notes issued.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500"><tr><th className="py-1">Number</th><th>Date</th><th>Reason</th><th className="text-right">Total</th></tr></thead>
            <tbody className="divide-y">
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="py-2"><Link className="underline" href={`/app/invoices/${i.id}`}>{i.number}</Link></td>
                  <td>{fmtDate(i.issuedAt)}</td>
                  <td>{i.reason}</td>
                  <td className="text-right font-mono">{formatInr(i.grossMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
