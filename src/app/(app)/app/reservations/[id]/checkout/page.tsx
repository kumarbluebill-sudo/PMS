import Link from "next/link";
import { randomUUID } from "node:crypto";
import { postRoomNightsAction, settleCheckoutAction } from "@/app/billing-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { folioDetail } from "@/server/services/billing";
import { checkoutOverview } from "@/server/services/checkout";
import { METHODS } from "@/server/services/payments";
import { settingsFor } from "@/server/services/settings";

export default async function CheckoutPage({ params, searchParams }: PageProps<"/app/reservations/[id]/checkout">) {
  const { id } = await params;
  const { error } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const o = await checkoutOverview(db, ctx, id);
  const st = await settingsFor(db, ctx);
  const r = o.reservation;
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  if (r.status !== "CHECKED_IN") {
    return (
      <>
        <PageHeader title={`Check-out: ${r.guest.name}`} />
        <p className="text-sm">This stay is {r.status.replace("_", " ").toLowerCase()}, so it cannot be checked out here. <Link className="underline" href={`/app/reservations/${id}`}>Back to the reservation</Link></p>
      </>
    );
  }
  const d = o.folioId && can("billing.view") ? await folioDetail(db, ctx, o.folioId) : null;
  const s = d?.summary;
  const balance = d?.balance ?? 0;
  const back = `/app/reservations/${id}/checkout`;
  const rows: [string, number][] = s
    ? [["Room charges", s.roomMinor], ["Extra-person charges", s.extraPersonMinor], ["Restaurant / food & beverage", s.restaurantMinor], ["Other services", s.otherServicesMinor], ["Discounts", -s.discountsMinor], ["Taxes (GST)", s.taxMinor]]
    : [];
  return (
    <>
      <PageHeader title={`Check-out: ${r.guest.name}`} subtitle={`${r.reference} · ${fmtDate(r.arrival)} → ${fmtDate(r.departure)}`} />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Review the bill">
          {o.unpostedNights > 0 && (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {o.unpostedNights} night(s) of room charges are not posted yet, so the figures below are not final.
              <form action={postRoomNightsAction} className="mt-2">
                <input type="hidden" name="reservationId" value={id} />
                <input type="hidden" name="folioId" value={o.folioId ?? ""} />
                <input type="hidden" name="back" value={back} />
                <button className={btnGhost}>Post room charges now</button>
              </form>
            </div>
          )}
          {s ? (
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
              {rows.map(([k, v]) => (<div key={k} className="contents"><dt>{k}</dt><dd className="text-right font-mono">{formatInr(v)}</dd></div>))}
              <dt className="border-t pt-1 font-semibold">Total bill</dt><dd className="border-t pt-1 text-right font-mono font-semibold">{formatInr(s.billedMinor)}</dd>
              <dt>Advance and payments received</dt><dd className="text-right font-mono">{formatInr(s.paymentsMinor)}</dd>
              <dt>Refunds</dt><dd className="text-right font-mono">{formatInr(s.refundsMinor)}</dd>
              <dt className="font-semibold">Balance due</dt><dd className={`text-right font-mono font-semibold ${balance > 0 ? "text-red-700" : ""}`}>{formatInr(balance)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-slate-600">No charges have been posted yet.{!can("billing.view") && " You do not have access to billing figures; the system still enforces the balance."}</p>
          )}
          {o.folioId && can("billing.view") && <p className="mt-3 text-sm"><Link className="underline" href={`/app/guest-folios/${o.folioId}`}>Open the full folio</Link> to add charges or discounts first.</p>}
        </Card>

        <Card title="2. Settle and check out">
          <form action={settleCheckoutAction} className="space-y-3">
            <input type="hidden" name="reservationId" value={id} />
            <input type="hidden" name="key" value={randomUUID()} />
            {can("payments.record") && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Payment received now (optional)</legend>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Method"><select name="method" className={input}>{METHODS.filter((m) => m !== "COMPANY_CREDIT" && st["billing.enabledPaymentMethods"].includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
                  <Field label="Amount (₹)"><input name="amount" inputMode="decimal" defaultValue={balance > 0 ? (balance / 100).toFixed(2) : ""} className={input} /></Field>
                </div>
                <Field label="Reference (UTR / slip no.)"><input name="reference" className={input} /></Field>
                <p className="text-xs text-slate-500">Only enter money you have actually received. Cash needs an open cashier shift.</p>
              </fieldset>
            )}
            {can("billing.waive") && (
              <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
                <legend className="px-1 text-sm font-medium">If a balance remains (manager approval)</legend>
                <Field label="Exception">
                  <select name="exceptionKind" defaultValue="" className={input}>
                    <option value="">None: the balance must be paid</option>
                    <option value="COMPANY_CREDIT">Company credit: a company will pay</option>
                    <option value="APPROVED_UNPAID">Approved unpaid balance</option>
                  </select>
                </Field>
                <Field label="Company or agent (for company credit)"><input name="company" className={input} /></Field>
                <Field label="Reason (required for an exception)"><input name="exceptionReason" className={input} /></Field>
              </fieldset>
            )}
            {can("invoices.issue") && (
              <fieldset className="space-y-2">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="issueInvoice" defaultChecked /> Issue the final invoice</label>
                <details className="text-sm">
                  <summary className="cursor-pointer">Company invoice (optional)</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <Field label="Name"><input name="recipientName" className={input} /></Field>
                    <Field label="GSTIN"><input name="recipientGstin" className={input} /></Field>
                    <Field label="Address"><input name="recipientAddress" className={input} /></Field>
                  </div>
                </details>
              </fieldset>
            )}
            <p className="text-xs text-slate-500">The room is left dirty for housekeeping; it is never marked clean automatically.</p>
            <button className={btn}>Complete check-out</button>
          </form>
        </Card>
      </div>
    </>
  );
}
