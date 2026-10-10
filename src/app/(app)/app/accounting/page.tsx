import { Card, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { reconcile, trialBalance } from "@/server/services/accounting";

export default async function Accounting() {
  const ctx = await getCtx();
  const [tb, rec] = await Promise.all([trialBalance(getDb(), ctx), reconcile(getDb(), ctx)]);
  const check = (ok: boolean, label: string) => (
    <li className={ok ? "text-green-800" : "font-semibold text-red-700"}>{ok ? "✔" : "✖"} {label}</li>
  );
  return (
    <>
      <PageHeader title="Accounting" subtitle="Double-entry journal generated automatically from folio charges, payments, refunds and credit notes." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Trial balance">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500"><tr><th className="py-1">Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
              <tbody className="divide-y">
                {tb.rows.map((r) => (
                  <tr key={r.code}><td className="py-1.5">{r.code} {r.name}</td><td className="text-right font-mono">{formatInr(r.debitMinor)}</td><td className="text-right font-mono">{formatInr(r.creditMinor)}</td></tr>
                ))}
              </tbody>
              <tfoot className="border-t font-semibold"><tr><td className="py-1.5">Total</td><td className="text-right font-mono">{formatInr(tb.totalDebit)}</td><td className="text-right font-mono">{formatInr(tb.totalCredit)}</td></tr></tfoot>
            </table>
          </Card>
        </div>
        <Card title="Integrity checks">
          <ul className="space-y-1 text-sm">
            {check(rec.journalBalanced, "Journal balances (debits = credits)")}
            {check(rec.receivableMatchesFolios, "Receivables control account = sum of folio balances")}
            {check(rec.invoiceTotalsMatchLines, "Invoice totals = sum of invoice lines")}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            A credit balance in Guest receivables represents advances held for guests. Profit &amp; loss, balance sheet, payables, expenses and period close are not built yet.
          </p>
        </Card>
      </div>
    </>
  );
}
