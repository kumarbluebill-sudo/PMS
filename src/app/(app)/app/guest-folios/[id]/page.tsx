import Link from "next/link";
import { randomUUID } from "node:crypto";
import {
  issueInvoiceAction, postChargeAction, postDiscountAction, postRoomNightsAction, recordPaymentAction, refundAction,
} from "@/app/billing-actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { CATEGORIES, folioDetail } from "@/server/services/billing";
import { METHODS } from "@/server/services/payments";

export default async function FolioPage({ params, searchParams }: PageProps<"/app/guest-folios/[id]">) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const d = await folioDetail(getDb(), ctx, id);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const f = d.folio;
  const uninvoiced = f.entries.filter((e) => (e.kind === "CHARGE" || e.kind === "DISCOUNT") && !e.line);
  const key = () => randomUUID();
  return (
    <>
      <PageHeader title={`Folio: ${f.reservation.guest.name}`} subtitle={`${f.reservation.reference} · ${fmtDate(f.reservation.arrival)} → ${fmtDate(f.reservation.departure)}`} />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 text-sm text-green-800">{ok}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><div className="text-xs text-slate-500">Billed (incl. GST)</div><div className="text-xl font-semibold">{formatInr(d.billed)}</div></Card>
        <Card><div className="text-xs text-slate-500">Paid</div><div className="text-xl font-semibold">{formatInr(d.paid)}</div></Card>
        <Card><div className="text-xs text-slate-500">Balance due</div><div className={`text-xl font-semibold ${d.balance > 0 ? "text-red-700" : ""}`}>{formatInr(d.balance)}</div></Card>
        <Card><div className="text-xs text-slate-500">Payment status</div><div className="mt-1"><Badge value={d.paymentStatus} /></div></Card>
      </div>

      <Card title="Ledger">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr><th className="py-1">Date</th><th>Description</th><th>Kind</th><th className="text-right">Net</th><th className="text-right">GST</th><th className="text-right">Effect</th><th>Invoice</th></tr>
            </thead>
            <tbody className="divide-y">
              {f.entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 whitespace-nowrap">{fmtDate(e.postedAt)}</td>
                  <td>{e.description}{e.reason && <span className="block text-xs text-slate-500">{e.reason}</span>}</td>
                  <td className="text-xs">{e.kind.toLowerCase()}</td>
                  <td className="text-right font-mono">{e.netMinor ? formatInr(e.netMinor) : ""}</td>
                  <td className="text-right font-mono">{e.taxMinor ? formatInr(e.taxMinor) : ""}</td>
                  <td className="text-right font-mono">{formatInr(e.balanceDeltaMinor)}</td>
                  <td className="text-xs">{e.line?.invoice.number ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {can("billing.post") && (
          <Card title="Post a charge">
            <form action={postChargeAction} className="space-y-2">
              <input type="hidden" name="folioId" value={f.id} />
              <input type="hidden" name="key" value={key()} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Category"><select name="category" className={input}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
                <Field label="Amount (₹)"><input name="amount" required inputMode="decimal" className={input} /></Field>
              </div>
              <Field label="Description"><input name="description" required className={input} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="taxInclusive" /> Amount includes GST</label>
              <input type="hidden" name="quantity" value="1" />
              <div className="flex gap-2">
                <button className={btn}>Post charge</button>
              </div>
            </form>
            <form action={postRoomNightsAction} className="mt-3">
              <input type="hidden" name="folioId" value={f.id} />
              <input type="hidden" name="reservationId" value={f.reservationId} />
              <button className={btnGhost}>Post room-night charges</button>
            </form>
          </Card>
        )}
        {can("payments.record") && (
          <Card title="Record a payment">
            <form action={recordPaymentAction} className="space-y-2">
              <input type="hidden" name="folioId" value={f.id} />
              <input type="hidden" name="key" value={key()} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Method"><select name="method" className={input}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
                <Field label="Amount (₹)"><input name="amount" required inputMode="decimal" defaultValue={d.balance > 0 ? (d.balance / 100).toFixed(2) : ""} className={input} /></Field>
              </div>
              <Field label="Reference (UTR / slip no.)"><input name="reference" className={input} /></Field>
              <p className="text-xs text-slate-500">Only record money you have actually received. Cash needs an open cashier shift.</p>
              <button className={btn}>Record payment</button>
            </form>
          </Card>
        )}
        {can("billing.discount") && (
          <Card title="Apply discount (needs a reason)">
            <form action={postDiscountAction} className="space-y-2">
              <input type="hidden" name="folioId" value={f.id} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Category"><select name="category" className={input}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
                <Field label="Amount (₹)"><input name="amount" required inputMode="decimal" className={input} /></Field>
              </div>
              <Field label="Description"><input name="description" required className={input} /></Field>
              <Field label="Reason"><input name="reason" required className={input} /></Field>
              <button className={btn}>Apply discount</button>
            </form>
          </Card>
        )}
        {can("payments.refund") && (
          <Card title="Refund">
            <form action={refundAction} className="space-y-2">
              <input type="hidden" name="folioId" value={f.id} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Method"><select name="method" className={input}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
                <Field label="Amount (₹)"><input name="amount" required inputMode="decimal" className={input} /></Field>
              </div>
              <Field label="Reason"><input name="reason" required className={input} /></Field>
              <button className={btn}>Refund</button>
            </form>
          </Card>
        )}
      </div>

      {can("invoices.issue") && (
        <Card title={`Invoice (${uninvoiced.length} uninvoiced line${uninvoiced.length === 1 ? "" : "s"})`}>
          {uninvoiced.length === 0 ? <p className="text-sm text-slate-500">Nothing to invoice.</p> : (
            <form action={issueInvoiceAction} className="space-y-3">
              <input type="hidden" name="folioId" value={f.id} />
              <fieldset className="space-y-1 text-sm">
                <legend className="font-medium">Include (all if none ticked)</legend>
                {uninvoiced.map((e) => (
                  <label key={e.id} className="flex items-center gap-2"><input type="checkbox" name="entryIds" value={e.id} /> {e.description} <span className="font-mono text-xs">{formatInr(e.balanceDeltaMinor)}</span></label>
                ))}
              </fieldset>
              <details className="text-sm">
                <summary className="cursor-pointer">Bill to a company (optional)</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <Field label="Name"><input name="recipientName" className={input} /></Field>
                  <Field label="GSTIN"><input name="recipientGstin" className={input} /></Field>
                  <Field label="Address"><input name="recipientAddress" className={input} /></Field>
                </div>
              </details>
              <p className="text-xs text-slate-500">Totals are computed on the server from the saved ledger. Issued invoices cannot be edited; corrections are made with a credit note.</p>
              <button className={btn}>Issue invoice</button>
            </form>
          )}
        </Card>
      )}
      {f.invoices.length > 0 && (
        <Card title="Documents">
          <ul className="text-sm">
            {f.invoices.map((i) => (
              <li key={i.id}><Link className="underline" href={`/app/invoices/${i.id}`}>{i.number}</Link> <span className="text-xs text-slate-500">{i.kind.replaceAll("_", " ").toLowerCase()}</span> {formatInr(i.grossMinor)}</li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
