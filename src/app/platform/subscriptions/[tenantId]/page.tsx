import { randomUUID } from "node:crypto";
import { failPaymentAction, issueRenewalAction, recordPaymentAction, subscriptionActionAction, voidInvoiceAction } from "@/app/platform-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, Notice, PageHeader, thead } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { getDb } from "@/server/db/client";
import { STATUS_LABEL, type SubStatus } from "@/server/domain/subscription";
import { requirePlatform } from "@/server/platform";
import { subscriptionDetail } from "@/server/services/platform";
import { PAYMENT_METHODS } from "@/server/services/subscription";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const inr = (minor: number) => `Rs. ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function HotelSubscription({ params, searchParams }: PageProps<"/platform/subscriptions/[tenantId]">) {
  const { tenantId } = await params;
  const sp = await searchParams;
  const p = await requirePlatform();
  const d = await subscriptionDetail(getDb(), p, tenantId);
  const write = p.role === "PLATFORM_SUPER_ADMIN";
  const sub = d.sub;
  const open = d.invoices.filter((i) => i.status === "OPEN");
  const key = randomUUID();
  return (
    <>
      <Breadcrumbs items={[{ label: "Subscriptions", href: "/platform/subscriptions" }, { label: d.tenant.displayName }]} />
      <PageHeader title={d.tenant.displayName} subtitle={d.tenant.legalName !== d.tenant.displayName ? d.tenant.legalName : undefined} />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}
      {!sub ? <Card><p className="text-sm">This hotel has no subscription.</p></Card> : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Subscription">
              <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
                <dt className="text-slate-600">Plan</dt><dd>{sub.plan.name}, {sub.interval === "ANNUAL" ? "yearly" : "monthly"}{sub.priceOverrideMinor != null ? `, price set to ${inr(sub.priceOverrideMinor)}` : ""}</dd>
                <dt className="text-slate-600">Status</dt><dd>{STATUS_LABEL[sub.status as SubStatus]}{sub.cancelAtPeriodEnd ? " (cancelling at period end)" : ""}</dd>
                {sub.trialEndsAt && <><dt className="text-slate-600">Trial ends</dt><dd>{fmtDate(sub.trialEndsAt)}</dd></>}
                {sub.periodEnd && <><dt className="text-slate-600">Period</dt><dd>{sub.periodStart ? fmtDate(sub.periodStart) : ""} to {fmtDate(sub.periodEnd)}</dd></>}
                {sub.graceEndsAt && <><dt className="text-slate-600">Grace ends</dt><dd>{fmtDate(sub.graceEndsAt)}</dd></>}
                <dt className="text-slate-600">Usage</dt><dd>{d.usage.properties} properties, {d.usage.rooms} rooms, {d.usage.users} users</dd>
                {sub.note && <><dt className="text-slate-600">Note</dt><dd>{sub.note}</dd></>}
              </dl>
            </Card>
            <Card title="Change this subscription">
              <form action={subscriptionActionAction} className="space-y-2">
                <input type="hidden" name="tenantId" value={tenantId} />
                <Field label="Action">
                  <select name="action" className={input} defaultValue="NOTE">
                    <option value="NOTE">Add a note</option>
                    <option value="EXTEND_TRIAL">Extend trial (needs days)</option>
                    {write && <><option value="ACTIVATE">Activate without payment</option><option value="SUSPEND">Suspend (read-only)</option><option value="CANCEL">Cancel now</option><option value="CHANGE_PLAN">Change plan or price</option></>}
                  </select>
                </Field>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Days (extend trial)"><input name="days" type="number" min={1} max={90} className={input} /></Field>
                  {write && <Field label="Plan (change plan)">
                    <select name="planCode" className={input} defaultValue={sub.plan.code}>{d.plans.map((pl) => <option key={pl.id} value={pl.code}>{pl.name}</option>)}</select>
                  </Field>}
                  {write && <Field label="Billing">
                    <select name="interval" className={input} defaultValue={sub.interval}><option value="MONTHLY">Monthly</option><option value="ANNUAL">Yearly</option></select>
                  </Field>}
                  {write && <Field label="Fixed price per period in rupees (blank = plan price)"><input name="priceOverride" className={input} inputMode="decimal" /></Field>}
                </div>
                <Field label="Reason (recorded in the audit log)"><input name="reason" required minLength={3} className={input} /></Field>
                <button className={btn}>Apply</button>
              </form>
            </Card>
          </div>

          <Card title="Invoices" actions={write ? <form action={issueRenewalAction}><input type="hidden" name="tenantId" value={tenantId} /><button className={btnGhost}>Create renewal invoice</button></form> : undefined}>
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className={thead}><tr><th className="p-2">Number</th><th>Kind</th><th>Issued</th><th>Due</th><th className="text-right">Total</th><th>Status</th><th>Tries</th></tr></thead>
              <tbody className="divide-y">
                {d.invoices.map((i) => (
                  <tr key={i.id}><td className="p-2 font-mono text-xs">{i.number}</td><td>{i.kind.toLowerCase()}</td><td>{fmtDate(i.issuedAt)}</td><td>{fmtDate(i.dueDate)}</td><td className="text-right">{inr(i.grossMinor)}</td><td>{i.status}</td><td>{i.attempts}</td></tr>
                ))}
                {d.invoices.length === 0 && <tr><td className="p-3 text-slate-600" colSpan={7}>No invoices.</td></tr>}
              </tbody>
            </table></div>
          </Card>

          {write && open.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Record a payment">
                <form action={recordPaymentAction} className="space-y-2">
                  <input type="hidden" name="tenantId" value={tenantId} /><input type="hidden" name="key" value={key} />
                  <Field label="Invoice"><select name="invoiceId" className={input}>{open.map((i) => <option key={i.id} value={i.id}>{i.number} ({inr(i.grossMinor)})</option>)}</select></Field>
                  <Field label="Amount received (rupees)"><input name="amount" required inputMode="decimal" className={input} /></Field>
                  <Field label="Method"><select name="method" className={input}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replaceAll("_", " ").toLowerCase()}</option>)}</select></Field>
                  <Field label="Reference (UTR, cheque number)"><input name="reference" className={input} /></Field>
                  <button className={btn}>Record payment</button>
                </form>
              </Card>
              <Card title="Mark an attempt as failed">
                <form action={failPaymentAction} className="space-y-2">
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <Field label="Invoice"><select name="invoiceId" className={input}>{open.map((i) => <option key={i.id} value={i.id}>{i.number}</option>)}</select></Field>
                  <Field label="What happened"><input name="reason" required minLength={3} className={input} /></Field>
                  <Field label="Remind again in (days)"><input name="days" type="number" min={1} max={30} defaultValue={3} className={input} /></Field>
                  <button className={btnGhost}>Record failed attempt</button>
                </form>
              </Card>
              <Card title="Cancel an invoice">
                <form action={voidInvoiceAction} className="space-y-2">
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <Field label="Invoice"><select name="invoiceId" className={input}>{open.map((i) => <option key={i.id} value={i.id}>{i.number}</option>)}</select></Field>
                  <Field label="Reason"><input name="reason" required minLength={3} className={input} /></Field>
                  <button className={btnGhost}>Cancel invoice</button>
                </form>
              </Card>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Payments">
              <ul className="space-y-1 text-sm">
                {d.payments.map((x) => <li key={x.id}>{fmtDate(x.createdAt)}: {inr(x.amountMinor)} by {x.method.replaceAll("_", " ").toLowerCase()}{x.reference ? `, ${x.reference}` : ""}{x.status === "FAILED" ? " (failed)" : ""}</li>)}
                {d.payments.length === 0 && <li className="text-slate-600">No payments.</li>}
              </ul>
            </Card>
            <Card title="History">
              <ul className="space-y-1 text-sm">
                {d.events.map((e) => <li key={e.id}><span className="text-slate-600">{fmtDate(e.createdAt)}</span> {e.type.replaceAll(".", " ").replaceAll("_", " ")}</li>)}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
