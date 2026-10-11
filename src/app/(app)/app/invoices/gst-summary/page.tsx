import { btn, btnGhost, Card, ErrorBanner, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { gstSummary } from "@/server/services/gstReports";
import { propertyToday } from "@/server/services/roomBlocks";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

export default async function GstSummaryPage({ searchParams }: PageProps<"/app/invoices/gst-summary">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const today = await propertyToday(db, ctx);
  const from = DAY.test(one(sp.from)) ? one(sp.from) : `${today.slice(0, 8)}01`;
  const to = DAY.test(one(sp.to)) ? one(sp.to) : today;
  let data: Awaited<ReturnType<typeof gstSummary>> | null = null;
  let error: string | null = null;
  try {
    data = await gstSummary(db, ctx, { from, to });
  } catch (e) {
    error = e instanceof Error && e.name === "ZodError" ? "Choose a valid date range." : e instanceof Error ? e.message : "Could not build the summary.";
  }
  const qs = new URLSearchParams({ from, to });
  return (
    <>
      <PageHeader title="GST summary" subtitle="Built from issued invoices, bills of supply, credit notes and debit notes. Credit notes are negative. This is an aid for your accountant, not a GST return." />
      <ErrorBanner message={error ?? undefined} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">From<input type="date" name="from" defaultValue={from} className={input} /></label>
        <label className="text-xs text-slate-600">To<input type="date" name="to" defaultValue={to} className={input} /></label>
        <button className={btn}>Show</button>
        <a className={btnGhost} href={`/app/invoices/gst-summary/export?${qs}&kind=summary`}>Download summary CSV</a>
        <a className={btnGhost} href={`/app/invoices/gst-summary/export?${qs}&kind=register`}>Download invoice register CSV</a>
      </form>
      {data && (
        <>
          <Card title="By SAC code and tax rate">
            {data.rows.length === 0 ? <p className="text-sm text-slate-500">No documents were issued in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-500">
                    <tr><th className="py-1">SAC</th><th>Rate</th><th>Treatment</th><th className="text-right">Taxable</th><th className="text-right">CGST</th><th className="text-right">SGST</th><th className="text-right">IGST</th><th className="text-right">Cess</th><th className="text-right">Total</th><th className="text-right">Lines</th></tr>
                  </thead>
                  <tbody className="divide-y font-mono">
                    {data.rows.map((r) => (
                      <tr key={`${r.sacCode}|${r.rateBp}|${r.cessBp}|${r.treatment}`}>
                        <td className="py-1.5">{r.sacCode || "—"}</td><td>{pct(r.rateBp)}{r.cessBp ? ` + ${pct(r.cessBp)} cess` : ""}</td><td className="font-sans text-xs">{r.treatment.replaceAll("_", " ").toLowerCase()}</td>
                        <td className="text-right">{formatInr(r.taxableMinor)}</td><td className="text-right">{formatInr(r.cgstMinor)}</td><td className="text-right">{formatInr(r.sgstMinor)}</td>
                        <td className="text-right">{formatInr(r.igstMinor)}</td><td className="text-right">{formatInr(r.cessMinor)}</td><td className="text-right">{formatInr(r.grossMinor)}</td><td className="text-right">{r.lines}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t font-mono font-semibold">
                    <tr><td colSpan={3} className="py-1.5 font-sans">Total</td><td className="text-right">{formatInr(data.totals.taxableMinor)}</td><td className="text-right">{formatInr(data.totals.cgstMinor)}</td><td className="text-right">{formatInr(data.totals.sgstMinor)}</td><td className="text-right">{formatInr(data.totals.igstMinor)}</td><td className="text-right">{formatInr(data.totals.cessMinor)}</td><td className="text-right">{formatInr(data.totals.grossMinor)}</td><td /></tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
          <div className="mt-4">
            <Card title={`Invoice register (${data.register.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-500"><tr><th className="py-1">Number</th><th>Date</th><th>Type</th><th>Recipient</th><th className="text-right">Taxable</th><th className="text-right">Tax</th><th className="text-right">Total</th></tr></thead>
                  <tbody className="divide-y">
                    {data.register.map((r) => (
                      <tr key={r.number}>
                        <td className="py-1.5 font-mono text-xs">{r.number}</td><td>{r.date}</td><td className="text-xs">{r.kind.replaceAll("_", " ").toLowerCase()}{r.originalNumber ? ` (vs ${r.originalNumber})` : ""}</td>
                        <td>{r.recipient}{r.recipientGstin ? ` · ${r.recipientGstin}` : ""}</td><td className="text-right font-mono">{formatInr(r.taxableMinor)}</td>
                        <td className="text-right font-mono">{formatInr(r.cgstMinor + r.sgstMinor + r.igstMinor + r.cessMinor)}</td><td className="text-right font-mono">{formatInr(r.grossMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
