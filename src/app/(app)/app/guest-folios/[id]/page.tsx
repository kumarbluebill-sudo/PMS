import Link from "next/link";
import { randomUUID } from "node:crypto";
import {
  createCompanyFolioAction, issueInvoiceAction, postChargeAction, postDiscountAction, postRoomNightsAction, recordPaymentAction,
  refundAction, transferEntriesAction,
} from "@/app/billing-actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { CATEGORIES, folioDetail } from "@/server/services/billing";
import { METHODS, REFUND_METHODS } from "@/server/services/payments";
import { propertyToday } from "@/server/services/roomBlocks";
import { settingsFor } from "@/server/services/settings";

const CATEGORY_LABEL: Record<string, string> = {
  ROOM: "Room", FNB: "Restaurant / food & beverage", SPA: "Spa", BANQUET: "Banquet / event", LAUNDRY: "Laundry",
  TRANSPORT: "Transport", EXTRA_BED: "Extra bed", OTHER: "Other service",
};

export default async function FolioPage({ params, searchParams }: PageProps<"/app/guest-folios/[id]">) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const d = await folioDetail(db, ctx, id);
  const today = await propertyToday(db, ctx);
  const st = await settingsFor(db, ctx);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const f = d.folio;
  const s = d.summary;
  const reversed = new Set(f.entries.map((e) => e.reversesEntryId).filter((x): x is string => !!x));
  const uninvoiced = f.entries.filter((e) => (e.kind === "CHARGE" || e.kind === "DISCOUNT") && !e.line && !reversed.has(e.id));
  const movable = uninvoiced.filter((e) => e.kind === "CHARGE");
  const company = d.siblings.find((x) => x.label === "COMPANY");
  const isCompany = f.label === "COMPANY";
  const key = () => randomUUID();
  const rows: [string, number][] = [
    ["Room charges", s.roomMinor], ["Extra-person charges", s.extraPersonMinor], ["Restaurant / food & beverage", s.restaurantMinor],
    ["Other services", s.otherServicesMinor], ["Discounts", -s.discountsMinor], ["Taxes (GST)", s.taxMinor],
  ];
  return (
    <>
      <PageHeader
        title={`${isCompany ? "Company folio" : "Folio"}: ${isCompany ? (f.billTo ?? "Company") : f.reservation.guest.name}`}
        subtitle={`${f.reservation.guest.name} · ${f.reservation.reference} · ${fmtDate(f.reservation.arrival)} → ${fmtDate(f.reservation.departure)}`}
      />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 text-sm text-green-800">{ok}</p>}
      <nav aria-label="Folios of this reservation" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {d.siblings.map((x) => (
          <Link key={x.id} className={btnGhost} href={`/app/guest-folios/${x.id}`}>{x.label === "COMPANY" ? `Company folio (${x.billTo ?? ""})` : "Guest folio"}</Link>
        ))}
        {f.reservation.status === "CHECKED_IN" && can("frontdesk.checkout") && !isCompany && (
          <Link className={btn} href={`/app/reservations/${f.reservationId}/checkout`}>Settle &amp; check out</Link>
        )}
      </nav>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><div className="text-xs text-slate-500">Billed (incl. GST)</div><div className="text-xl font-semibold">{formatInr(d.billed)}</div></Card>
        <Card><div className="text-xs text-slate-500">Paid</div><div className="text-xl font-semibold">{formatInr(d.paid)}</div></Card>
        <Card><div className="text-xs text-slate-500">Balance due</div><div className={`text-xl font-semibold ${d.balance > 0 ? "text-red-700" : ""}`}>{formatInr(d.balance)}</div></Card>
        <Card><div className="text-xs text-slate-500">Payment status</div><div className="mt-1"><Badge value={d.paymentStatus} /></div></Card>
      </div>

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <Card title="Billing summary">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="contents"><dt>{k}</dt><dd className="text-right font-mono">{formatInr(v)}</dd></div>
            ))}
            <dt className="border-t pt-1 font-semibold">Total bill</dt><dd className="border-t pt-1 text-right font-mono font-semibold">{formatInr(s.billedMinor)}</dd>
            <dt>Advance received</dt><dd className="text-right font-mono">{formatInr(s.advanceMinor)}</dd>
            <dt>Payments received (all)</dt><dd className="text-right font-mono">{formatInr(s.paymentsMinor)}</dd>
            <dt>Refunds</dt><dd className="text-right font-mono">{formatInr(s.refundsMinor)}</dd>
            <dt className="font-semibold">Outstanding</dt><dd className="text-right font-mono font-semibold">{formatInr(s.balanceMinor)}</dd>
          </dl>
        </Card>
        {can("billing.post") && !isCompany && (
          <Card title="Company or agent billing">
            {company ? (
              <p className="text-sm">A company folio exists for <strong>{company.billTo}</strong>. <Link className="underline" href={`/app/guest-folios/${company.id}`}>Open it</Link>.</p>
            ) : (
              <form action={createCompanyFolioAction} className="space-y-2">
                <input type="hidden" name="folioId" value={f.id} /><input type="hidden" name="reservationId" value={f.reservationId} />
                <Field label="Bill some charges to (company / agent)"><input name="billTo" required minLength={2} className={input} /></Field>
                <button className={btnGhost}>Open company folio</button>
              </form>
            )}
            {company && can("billing.waive") && movable.length > 0 && (
              <form action={transferEntriesAction} className="mt-3 space-y-2 border-t pt-3">
                <input type="hidden" name="folioId" value={f.id} /><input type="hidden" name="toFolioId" value={company.id} />
                <fieldset className="space-y-1 text-sm">
                  <legend className="font-medium">Move charges to the company folio</legend>
                  {movable.map((e) => <label key={e.id} className="flex items-center gap-2"><input type="checkbox" name="entryIds" value={e.id} />{e.description} <span className="font-mono text-xs">{formatInr(e.balanceDeltaMinor)}</span></label>)}
                </fieldset>
                <Field label="Reason"><input name="reason" required minLength={3} className={input} /></Field>
                <button className={btnGhost}>Move selected</button>
              </form>
            )}
          </Card>
        )}
      </div>

      <p className="mb-2 flex flex-wrap gap-2 text-sm">
        <a className={btnGhost} href={`/app/guest-folios/${f.id}/statement`}>Folio statement (PDF)</a>
        <a className={btnGhost} href={`/app/guest-folios/${f.id}/statement?type=interim`}>Interim bill (PDF)</a>
        {can("invoices.issue") && <a className={btnGhost} href={`/app/guest-folios/${f.id}/proforma`}>Pro forma invoice (PDF)</a>}
      </p>
      <Card title="Itemised ledger">
        <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Folio ledger, scrolls sideways">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="text-xs text-slate-600">
              <tr>
                <th scope="col" className="py-1 pr-2">Date</th><th scope="col" className="pr-2">Description</th><th scope="col" className="pr-2">Ref</th>
                <th scope="col" className="pr-2 text-right">Qty</th><th scope="col" className="pr-2 text-right">Rate</th><th scope="col" className="pr-2 text-right">Discount</th>
                <th scope="col" className="pr-2 text-right">Taxable</th><th scope="col" className="pr-2 text-right">GST</th><th scope="col" className="pr-2 text-right">Line total</th>
                <th scope="col">Payment / document</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {f.entries.map((e) => {
                const t = e.taxDetail as { rateBp?: number; cgstMinor?: number; sgstMinor?: number; igstMinor?: number; cessMinor?: number } | null;
                const charge = e.kind === "CHARGE";
                const parts = t ? [["CGST", t.cgstMinor], ["SGST", t.sgstMinor], ["IGST", t.igstMinor], ["Cess", t.cessMinor]].filter(([, v]) => v) as [string, number][] : [];
                return (
                  <tr key={e.id} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-2">{fmtDate(e.serviceDate ?? e.postedAt)}</td>
                    <td className="pr-2">{e.description}<span className="block text-xs text-slate-600">{e.kind.toLowerCase()}{e.category !== "ROOM" && e.kind === "CHARGE" ? ` · ${(CATEGORY_LABEL[e.category] ?? e.category).toLowerCase()}` : ""}{e.reason ? ` · ${e.reason}` : ""}</span></td>
                    <td className="pr-2 text-xs">{e.category === "ROOM" ? f.reservation.reference : ""}</td>
                    <td className="pr-2 text-right tabular-nums">{charge ? e.quantity : ""}</td>
                    <td className="pr-2 text-right font-mono">{charge && e.netMinor ? formatInr(Math.round(e.netMinor / Math.max(1, e.quantity))) : ""}</td>
                    <td className="pr-2 text-right font-mono">{e.kind === "DISCOUNT" ? formatInr(Math.abs(e.netMinor || e.balanceDeltaMinor)) : ""}</td>
                    <td className="pr-2 text-right font-mono">{e.netMinor ? formatInr(e.netMinor) : ""}</td>
                    <td className="pr-2 text-right font-mono">{e.taxMinor ? formatInr(e.taxMinor) : ""}
                      {parts.length > 0 && <span className="block text-xs text-slate-600">{t?.rateBp ? `${(t.rateBp / 100).toFixed(t.rateBp % 100 ? 2 : 0)}%: ` : ""}{parts.map(([n, v]) => `${n} ${formatInr(v)}`).join(", ")}</span>}</td>
                    <td className="pr-2 text-right font-mono">{formatInr(e.balanceDeltaMinor)}</td>
                    <td className="text-xs">
                      {e.paymentId && <span className="block">{d.paymentRefs.get(e.paymentId) ?? "payment"}</span>}
                      {e.line?.invoice.number ?? ""}
                      {e.paymentId && <> <Link className="underline" href={`/app/payments/${e.paymentId}/receipt`}>Receipt</Link></>}
                    </td>
                  </tr>
                );
              })}
              {f.entries.length === 0 && <tr><td colSpan={10} className="py-3 text-slate-600">Nothing posted yet. Room nights post at checkout; post other charges below.</td></tr>}
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
                <Field label="Service / tax category"><select name="category" className={input}>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}</select></Field>
                <Field label="Posting date"><input type="date" name="serviceDate" defaultValue={today} max={today} min={f.reservation.arrival.toISOString().slice(0, 10)} className={input} /></Field>
                <Field label="Rate per unit (₹)"><input name="amount" required inputMode="decimal" className={input} /></Field>
                <Field label="Quantity"><input name="quantity" type="number" min={1} defaultValue={1} className={input} /></Field>
              </div>
              <Field label="Description"><input name="description" required className={input} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="taxInclusive" defaultChecked={st["billing.taxInclusiveDefault"]} /> Rate includes GST</label>
              <div className="flex gap-2">
                <button className={btn}>Post charge</button>
              </div>
            </form>
            {!isCompany && (
              <form action={postRoomNightsAction} className="mt-3">
                <input type="hidden" name="folioId" value={f.id} />
                <input type="hidden" name="reservationId" value={f.reservationId} />
                <button className={btnGhost}>Post room-night charges</button>
              </form>
            )}
          </Card>
        )}
        {can("payments.record") && (
          <Card title="Record a payment">
            <form action={recordPaymentAction} className="space-y-2">
              <input type="hidden" name="folioId" value={f.id} />
              <input type="hidden" name="key" value={key()} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Method"><select name="method" className={input}>{METHODS.filter((m) => st["billing.enabledPaymentMethods"].includes(m) && (m !== "COMPANY_CREDIT" || can("billing.waive"))).map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
                <Field label="Amount (₹)"><input name="amount" required inputMode="decimal" defaultValue={d.balance > 0 ? (d.balance / 100).toFixed(2) : ""} className={input} /></Field>
              </div>
              <Field label="Reference (UTR / slip no. / company name)"><input name="reference" className={input} /></Field>
              <p className="text-xs text-slate-500">Only record money you have actually received. Cash needs an open cashier shift. Company credit needs a manager and the company&apos;s name.</p>
              <button className={btn}>Record payment</button>
            </form>
          </Card>
        )}
        {can("billing.discount") && (
          <Card title="Apply discount (needs a reason)">
            <form action={postDiscountAction} className="space-y-2">
              <input type="hidden" name="folioId" value={f.id} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Category"><select name="category" className={input}>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}</select></Field>
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
                <Field label="Method"><select name="method" className={input}>{REFUND_METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
                <Field label="Amount (₹)"><input name="amount" required inputMode="decimal" className={input} /></Field>
              </div>
              <Field label="Reason"><input name="reason" required className={input} /></Field>
              <button className={btn}>Refund</button>
            </form>
          </Card>
        )}
      </div>

      {can("invoices.issue") && (
        <div className="mt-4">
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
                <details className="text-sm" open={isCompany}>
                  <summary className="cursor-pointer">{isCompany ? "Company details for the invoice" : "Bill to a company (optional)"}</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <Field label="Name"><input name="recipientName" defaultValue={isCompany ? (f.billTo ?? "") : ""} className={input} /></Field>
                    <Field label="GSTIN"><input name="recipientGstin" className={input} /></Field>
                    <Field label="Address"><input name="recipientAddress" className={input} /></Field>
                  </div>
                </details>
                <p className="text-xs text-slate-500">Totals are computed on the server from the saved ledger. Issued invoices cannot be edited; corrections are made with a credit note or a debit note.</p>
                <button className={btn}>Issue invoice</button>
              </form>
            )}
          </Card>
        </div>
      )}
      {f.invoices.length > 0 && (
        <div className="mt-4">
          <Card title="Documents">
            <ul className="text-sm">
              {f.invoices.map((i) => (
                <li key={i.id}><Link className="underline" href={`/app/invoices/${i.id}`}>{i.number}</Link> <span className="text-xs text-slate-500">{i.kind.replaceAll("_", " ").toLowerCase()}</span> {formatInr(i.grossMinor)}</li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
