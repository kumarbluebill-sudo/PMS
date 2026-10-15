import Link from "next/link";
import { randomUUID } from "node:crypto";
import { postRoomNightsAction, settleCheckoutAction } from "@/app/billing-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { folioDetail } from "@/server/services/billing";
import { checkoutOverview } from "@/server/services/checkout";
import { METHODS } from "@/server/services/payments";
import { propertyToday } from "@/server/services/roomBlocks";
import { settingsFor } from "@/server/services/settings";

const STEPS = ["Verify stay", "Review folio", "Settle bill", "Documents", "Confirm"];

export default async function CheckoutPage({ params, searchParams }: PageProps<"/app/reservations/[id]/checkout">) {
  const { id } = await params;
  const { error } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const o = await checkoutOverview(db, ctx, id);
  const st = await settingsFor(db, ctx);
  const today = await propertyToday(db, ctx);
  const r = o.reservation;
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  if (r.status !== "CHECKED_IN") {
    return (
      <>
        <PageHeader title={`Check-out: ${r.guest.name}`} />
        <p className="text-sm">This stay is {r.status.replace("_", " ").toLowerCase()}, so it cannot be checked out here. <Link className="underline" href={`/app/reservations/${id}`}>Back to the reservation</Link>{r.status === "CHECKED_OUT" && <> · <Link className="underline" href={`/app/reservations/${id}/checkout/done`}>See the check-out summary</Link></>}</p>
      </>
    );
  }
  const d = o.folioId && can("billing.view") ? await folioDetail(db, ctx, o.folioId) : null;
  const s = d?.summary;
  const balance = d?.balance ?? 0;
  const back = `/app/reservations/${id}/checkout`;
  const overdue = fmtDate(r.departure) < today;
  const methods = METHODS.filter((m) => m !== "COMPANY_CREDIT" && st["billing.enabledPaymentMethods"].includes(m));
  const keys = [randomUUID(), randomUUID(), randomUUID()];
  const rows: [string, number][] = s
    ? [["Room charges", s.roomMinor], ["Extra-person charges", s.extraPersonMinor], ["Restaurant / food & beverage", s.restaurantMinor], ["Other services", s.otherServicesMinor], ["Discounts", -s.discountsMinor], ["Taxes (GST)", s.taxMinor]]
    : [];
  const blocked = o.companyOpen.length > 0;

  return (
    <>
      <Breadcrumbs items={[{ label: "Today's operations", href: "/app/operations" }, { label: `Check-out ${r.reference}` }]} />
      <PageHeader title={`Check-out: ${r.guest.name}`} subtitle={`${r.reference} · ${fmtDate(r.arrival)} → ${fmtDate(r.departure)}`} />
      <ol aria-label="Checkout steps" className="mb-4 flex flex-wrap gap-2 text-xs">
        {STEPS.map((t, i) => <li key={t} className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-slate-800"><span className="font-semibold">{i + 1}.</span> {t}</li>)}
      </ol>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="1. Verify guest and stay">
            <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-600">Reservation</dt><dd className="font-mono">{r.reference}</dd>
              <dt className="text-slate-600">Guest</dt><dd>{r.guest.name}</dd>
              <dt className="text-slate-600">Room</dt><dd>{o.roomNumber ?? "Not assigned"}</dd>
              <dt className="text-slate-600">Checked in</dt><dd>{o.checkedInAt ? `${o.checkedInAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : fmtDate(r.arrival)}</dd>
              <dt className="text-slate-600">Expected departure</dt><dd>{fmtDate(r.departure)}{overdue ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950">Overdue: past the booked date</span> : null}</dd>
              <dt className="text-slate-600">Departure recorded as</dt><dd>The time you complete check-out</dd>
              {r.lateCheckoutRequest && (<><dt className="text-slate-600">Late checkout</dt><dd>{r.lateCheckoutRequest}. No fee is added automatically; add it on the folio if it applies.</dd></>)}
            </dl>
          </Card>

          <Card title="2. Review the folio">
            {o.unpostedNights > 0 && (
              <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                {o.unpostedNights} night(s) of room charges are not posted yet. They are posted automatically when you complete the check-out, but you can post them now to see the final figures.
                <form action={postRoomNightsAction} className="mt-2">
                  <input type="hidden" name="reservationId" value={id} /><input type="hidden" name="folioId" value={o.folioId ?? ""} /><input type="hidden" name="back" value={back} />
                  <button className={btnGhost}>Post room charges now</button>
                </form>
              </div>
            )}
            {blocked && (
              <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950">
                {o.companyOpen.map((c) => <p key={c.id}>The company folio{c.billTo ? ` for ${c.billTo}` : ""} has {formatInr(c.uninvoicedMinor)} of charges that are not invoiced. <Link className="underline" href={`/app/guest-folios/${c.id}`}>Open it</Link> to invoice or move them before checking out.</p>)}
              </div>
            )}
            {s ? (
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                {rows.map(([k, v]) => (<div key={k} className="contents"><dt>{k}</dt><dd className="text-right font-mono">{formatInr(v)}</dd></div>))}
                <dt className="border-t pt-1 font-semibold">Total bill</dt><dd className="border-t pt-1 text-right font-mono font-semibold">{formatInr(s.billedMinor)}</dd>
                <dt>Advance and payments received</dt><dd className="text-right font-mono">{formatInr(s.paymentsMinor)}</dd>
                <dt>Refunds and credits</dt><dd className="text-right font-mono">{formatInr(s.refundsMinor)}</dd>
                <dt className="font-semibold">Balance due</dt><dd className={`text-right font-mono font-semibold ${balance > 0 ? "text-red-700" : ""}`}>{formatInr(balance)}</dd>
              </dl>
            ) : (
              <p className="text-sm text-slate-700">No charges have been posted yet.{!can("billing.view") && " You do not have access to billing figures; the system still enforces the balance."}</p>
            )}
            {d && d.folio.invoices.length > 0 && <p className="mt-3 text-sm">Invoices already issued: {d.folio.invoices.map((i) => <Link key={i.id} className="mr-2 underline" href={`/app/invoices/${i.id}`}>{i.number}</Link>)}</p>}
            {o.folioId && can("billing.view") && <p className="mt-3 text-sm"><Link className="underline" href={`/app/guest-folios/${o.folioId}`}>Open the full folio</Link> to add charges, discounts or refunds first.</p>}
          </Card>
        </div>

        <Card title="3. Settle, then issue documents and confirm">
          <form action={settleCheckoutAction} className="space-y-4">
            <input type="hidden" name="reservationId" value={id} />
            {keys.map((k, i) => <input key={k} type="hidden" name={`key_${i + 1}`} value={k} />)}
            {can("payments.record") && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Payments received now (up to three, for split payment)</legend>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1.2fr] gap-2">
                    <Field label={`Method ${i}`}><select name={`method_${i}`} className={input}>{methods.map((m) => <option key={m} value={m}>{m.replace("_", " ").toLowerCase()}</option>)}</select></Field>
                    <Field label={`Amount ${i} (₹)`}><input name={`amount_${i}`} inputMode="decimal" defaultValue={i === 1 && balance > 0 ? (balance / 100).toFixed(2) : ""} className={input} /></Field>
                    <Field label={`Reference ${i}`}><input name={`reference_${i}`} placeholder="UTR or slip no." className={input} /></Field>
                  </div>
                ))}
                <p className="text-xs text-slate-600">Only enter money you have actually received. Cash needs an open cashier shift. Leave a line empty to skip it. Pressing the button twice never takes a payment twice.</p>
              </fieldset>
            )}
            {can("billing.waive") && (
              <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
                <legend className="px-1 text-sm font-medium">If a balance remains (manager approval, recorded with the reason)</legend>
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
                <legend className="text-sm font-medium">Documents</legend>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="issueInvoice" defaultChecked /> Issue the final invoice</label>
                <p className="text-xs text-slate-600">A receipt is created for every payment recorded here. After check-out you can print or download them.</p>
                <details className="text-sm">
                  <summary className="cursor-pointer">Company invoice (optional)</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <Field label="Invoice name"><input name="recipientName" className={input} /></Field>
                    <Field label="GSTIN"><input name="recipientGstin" className={input} /></Field>
                    <Field label="Address"><input name="recipientAddress" className={input} /></Field>
                  </div>
                </details>
              </fieldset>
            )}
            <fieldset className="space-y-2 rounded-md border border-brand-200 bg-brand-50/40 p-3">
              <legend className="px-1 text-sm font-medium">5. Confirm</legend>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" required className="mt-1" /> I confirm the guest has left, the bill is settled as shown, and the room can go to housekeeping.</label>
              <p className="text-xs text-slate-600">Everything saves together or not at all. The departure time is recorded, the room becomes Vacant Dirty and housekeeping is notified. It is never marked clean automatically.</p>
              <button className={btn} disabled={blocked}>Complete check-out</button>
            </fieldset>
          </form>
        </Card>
      </div>
    </>
  );
}
