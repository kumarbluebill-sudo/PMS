import { creditNoteAction } from "@/app/billing-actions";
import { btn, ErrorBanner, Field, input } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { GST_STATES } from "@/server/domain/gst";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { getInvoice } from "@/server/services/invoicing";
import { PrintButton } from "../../PrintButton";

type Party = { name?: string; gstin?: string | null; stateCode?: string | null; address?: string | null; registered?: boolean };

export default async function InvoicePage({ params, searchParams }: PageProps<"/app/invoices/[id]">) {
  const { id } = await params;
  const { error } = await searchParams;
  const ctx = await getCtx();
  const inv = await getInvoice(getDb(), ctx, id);
  const sup = inv.supplier as Party;
  const rec = inv.recipient as Party;
  const title = { TAX_INVOICE: "Tax Invoice", BILL_OF_SUPPLY: "Bill of Supply", CREDIT_NOTE: "Credit Note", DEBIT_NOTE: "Debit Note" }[inv.kind] ?? inv.kind;
  const canCredit = roleHasPermission(ctx.role, "creditnotes.issue", ctx.extra) && (inv.kind === "TAX_INVOICE" || inv.kind === "BILL_OF_SUPPLY");
  const cols = inv.kind === "TAX_INVOICE" || inv.kind === "CREDIT_NOTE";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center justify-between print:hidden"><ErrorBanner message={typeof error === "string" ? error : undefined} /><PrintButton /></div>
      <article className="rounded-lg border border-slate-200 bg-white p-6 text-sm shadow-sm print:border-0 print:shadow-none">
        <header className="flex flex-wrap justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="font-mono">{inv.number}</p>
            <p>Date: {inv.issuedDate}</p>
            {inv.originalNumber && <p>Against invoice: {inv.originalNumber}</p>}
            {inv.reason && <p>Reason: {inv.reason}</p>}
          </div>
          <div className="text-right">
            <p className="font-semibold">{sup.name}</p>
            {sup.address && <p>{sup.address}</p>}
            {sup.gstin ? <p>GSTIN: {sup.gstin} ({GST_STATES[sup.stateCode ?? ""] ?? sup.stateCode})</p> : <p className="text-slate-500">Not registered under GST</p>}
          </div>
        </header>
        <section className="mt-4">
          <p className="text-xs uppercase text-slate-500">Bill to</p>
          <p className="font-medium">{rec.name}</p>
          {rec.address && <p>{rec.address}</p>}
          {rec.gstin && <p>GSTIN: {rec.gstin}</p>}
          {inv.placeOfSupply && <p>Place of supply: {GST_STATES[inv.placeOfSupply] ?? inv.placeOfSupply} ({inv.placeOfSupply})</p>}
        </section>
        <table className="mt-4 w-full text-left">
          <thead className="border-b text-xs text-slate-500">
            <tr><th className="py-1">Description</th><th>SAC</th><th className="text-right">Taxable</th>{cols && <><th className="text-right">CGST</th><th className="text-right">SGST</th><th className="text-right">IGST</th><th className="text-right">Cess</th></>}<th className="text-right">Total</th></tr>
          </thead>
          <tbody className="divide-y">
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td className="py-1.5">{l.description}</td>
                <td>{l.sacCode ?? ""}</td>
                <td className="text-right font-mono">{formatInr(l.netMinor)}</td>
                {cols && <><td className="text-right font-mono">{formatInr(l.cgstMinor)}</td><td className="text-right font-mono">{formatInr(l.sgstMinor)}</td><td className="text-right font-mono">{formatInr(l.igstMinor)}</td><td className="text-right font-mono">{formatInr(l.cessMinor)}</td></>}
                <td className="text-right font-mono">{formatInr(l.grossMinor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t font-semibold">
            <tr><td colSpan={2} className="py-1.5">Total</td><td className="text-right font-mono">{formatInr(inv.netMinor)}</td>{cols && <><td className="text-right font-mono">{formatInr(inv.cgstMinor)}</td><td className="text-right font-mono">{formatInr(inv.sgstMinor)}</td><td className="text-right font-mono">{formatInr(inv.igstMinor)}</td><td className="text-right font-mono">{formatInr(inv.cessMinor)}</td></>}<td className="text-right font-mono">{formatInr(inv.grossMinor)}</td></tr>
          </tfoot>
        </table>
        {inv.kind === "BILL_OF_SUPPLY" && <p className="mt-3 text-xs text-slate-500">No GST has been charged on this document.</p>}
      </article>
      {canCredit && (
        <form action={creditNoteAction} className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-white p-4 print:hidden">
          <h2 className="text-sm font-semibold">Issue a credit note</h2>
          <input type="hidden" name="invoiceId" value={inv.id} />
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Lines to credit (all if none ticked)</legend>
            {inv.lines.map((l) => (
              <label key={l.id} className="flex items-center gap-2"><input type="checkbox" name="lineEntryIds" value={l.folioEntryId} /> {l.description} <span className="font-mono text-xs">{formatInr(l.grossMinor)}</span></label>
            ))}
          </fieldset>
          <Field label="Reason"><input name="reason" required className={input} /></Field>
          <button className={btn}>Issue credit note</button>
        </form>
      )}
    </div>
  );
}
