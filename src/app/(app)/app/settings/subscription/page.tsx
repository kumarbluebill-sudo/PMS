import Link from "next/link";
import { applyCouponAction, cancelSubscriptionAction, changePlanAction, clearScheduledChangeAction, resumeSubscriptionAction } from "@/app/subscription-actions";
import { btn, btnGhost, Card, ErrorBanner, fmtDate, Field, input, Notice, PageHeader, thead } from "@/app/ui";
import ConfirmAction from "@/components/ConfirmAction";
import { getDb } from "@/server/db/client";
import { roleHasPermission } from "@/server/auth/permissions";
import { FEATURES, hasFeature, planPrice, STATUS_LABEL, type Interval } from "@/server/domain/subscription";
import { getCtx } from "@/server/session";
import { previewPlanChange, subscriptionOverview } from "@/server/services/subscription";
import { AppError } from "@/server/errors";

/** A file download, not a page: a plain link, so the browser saves it. */
const EXPORT_URL = "/app/settings/subscription/export";
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const inr = (minor: number) => `Rs. ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const limitText = (n: number | null, one: string, many: string) => (n == null ? "Unlimited" : `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`);

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit == null ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const bar = limit == null ? "bg-brand-600" : used >= limit ? "bg-red-600" : pct >= 90 ? "bg-amber-500" : "bg-brand-600";
  return (
    <div>
      <div className="flex justify-between text-sm"><span>{label}</span><span className="text-slate-700">{used.toLocaleString("en-IN")} of {limit == null ? "unlimited" : limit.toLocaleString("en-IN")}</span></div>
      <div className="mt-1 h-2 rounded bg-slate-100" role="img" aria-label={`${label}: ${used} used${limit == null ? ", no limit" : ` of ${limit}`}`}>
        <div className={`h-2 rounded ${bar}`} style={{ width: limit == null ? "6%" : `${Math.max(pct, used > 0 ? 3 : 0)}%` }} />
      </div>
    </div>
  );
}

export default async function SubscriptionSettings({ searchParams }: PageProps<"/app/settings/subscription">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to this page.</p>;
  const manage = roleHasPermission(ctx.role, "subscription.manage", ctx.extra);
  const o = await subscriptionOverview(getDb(), ctx);
  if (!o) {
    return (
      <>
        <PageHeader title="Subscription & Plans" subtitle="Your plan with MK Solutions." />
        <Card><p className="text-sm text-slate-700">No subscription is set up for this account yet. Contact support.</p></Card>
      </>
    );
  }
  const { sub, plan } = o;
  const interval = sub.interval as Interval;

  // A chosen plan is previewed first, then confirmed.
  const wantCode = one(sp.preview);
  const wantInterval = one(sp.interval) === "ANNUAL" ? "ANNUAL" : "MONTHLY";
  let preview: Awaited<ReturnType<typeof previewPlanChange>> | null = null;
  let previewError = "";
  if (wantCode) {
    try { preview = await previewPlanChange(getDb(), ctx, { planCode: wantCode, interval: wantInterval }); } catch (e) { previewError = e instanceof AppError ? e.message : "That plan cannot be previewed."; }
  }
  const openInvoices = o.invoices.filter((i) => i.status === "OPEN");

  return (
    <>
      <PageHeader
        title="Subscription & Plans"
        subtitle="Your plan with MK Solutions, what you use, and your invoices."
        actions={<a className={btnGhost} href={EXPORT_URL}>Export all my data (Excel)</a>}
      />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}
      {ctx.readOnly && <Notice tone="warn">This account is read-only until the subscription is active again. Nothing has been deleted. You can still view and export everything.</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Current plan">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-600">Plan</dt><dd className="font-medium">{plan.name}</dd>
            <dt className="text-slate-600">Status</dt><dd>{STATUS_LABEL[o.status]}{sub.cancelAtPeriodEnd ? " (ends at the end of this period)" : ""}</dd>
            <dt className="text-slate-600">Billing</dt><dd>{interval === "ANNUAL" ? "Yearly" : "Monthly"}, {o.price === 0 ? "no charge" : `${inr(o.price)} plus GST`}</dd>
            {sub.trialEndsAt && <><dt className="text-slate-600">Trial ends</dt><dd>{fmtDate(sub.trialEndsAt)}</dd></>}
            {sub.periodEnd ? <><dt className="text-slate-600">{sub.cancelAtPeriodEnd ? "Access until" : "Renews on"}</dt><dd>{fmtDate(sub.periodEnd)}</dd></> : sub.status === "ACTIVE" ? <><dt className="text-slate-600">Renews on</dt><dd>No renewal date</dd></> : null}
            {sub.graceEndsAt && <><dt className="text-slate-600">Pay by</dt><dd>{fmtDate(sub.graceEndsAt)}</dd></>}
            {o.coupon && sub.couponMonthsLeft > 0 && <><dt className="text-slate-600">Coupon</dt><dd>{o.coupon.code} ({sub.couponMonthsLeft} invoice{sub.couponMonthsLeft === 1 ? "" : "s"} left)</dd></>}
            {o.pendingPlan && <><dt className="text-slate-600">Next renewal</dt><dd>Moves to {o.pendingPlan.name}, {sub.pendingInterval === "ANNUAL" ? "yearly" : "monthly"}</dd></>}
            {sub.note && <><dt className="text-slate-600">Note</dt><dd>{sub.note}</dd></>}
          </dl>
          {manage && (
            <div className="mt-3 flex flex-wrap gap-2">
              {o.pendingPlan && <form action={clearScheduledChangeAction}><button className={btnGhost}>Remove the scheduled change</button></form>}
              {sub.cancelAtPeriodEnd && sub.status === "ACTIVE" && <form action={resumeSubscriptionAction}><button className={btnGhost}>Keep my subscription</button></form>}
              {!sub.cancelAtPeriodEnd && (sub.status === "ACTIVE" || sub.status === "PAYMENT_DUE") && (
                <ConfirmAction action={cancelSubscriptionAction} fields={{}} title="Cancel subscription" label="Cancel subscription" confirmLabel="Cancel at end of period" reasonLabel="Why are you cancelling?"
                  impact={<>Your plan keeps working until {sub.periodEnd ? fmtDate(sub.periodEnd) : "the end of the period"}. After that the account becomes read-only. Nothing is deleted and you can export everything.</>} />
              )}
            </div>
          )}
        </Card>

        <Card title="What you use">
          <div className="space-y-3">
            <Meter label="Properties" used={o.usage.properties} limit={plan.maxProperties} />
            <Meter label="Rooms" used={o.usage.rooms} limit={plan.maxRooms} />
            <Meter label="Users" used={o.usage.users} limit={plan.maxUsers} />
            <p className="text-xs text-slate-600">Storage and integrations are not used yet, so they show no usage. {limitText(plan.maxStorageMb, "MB of storage", "MB of storage")} and {limitText(plan.maxIntegrations, "integration", "integrations")} are included.</p>
          </div>
        </Card>
      </div>

      {openInvoices.length > 0 && (
        <div className="mt-4"><Card title="How to pay">
          <p className="text-sm text-slate-800">Open invoice{openInvoices.length === 1 ? "" : "s"}: {openInvoices.map((i) => `${i.number} (${inr(i.grossMinor)})`).join(", ")}.</p>
          <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{o.payment.instructions || "Payment details have not been added yet. Contact support."}</p>
          <p className="mt-2 text-xs text-slate-600">Payments are recorded by MK Solutions after they are received. Your plan updates then; there is no online payment yet.</p>
        </Card></div>
      )}

      {manage && (
        <div className="mt-4">
          <Card title="Change plan">
            {preview && (
              <div className="mb-4 rounded-md border border-brand-200 bg-brand-50 p-3 text-sm" aria-label="Plan change preview">
                <p className="font-medium">{preview.plan.name}, {preview.interval === "ANNUAL" ? "yearly" : "monthly"}</p>
                {preview.blockers.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5 text-red-800">{preview.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                ) : preview.mode === "UPGRADE" ? (
                  <p className="mt-1">Upgrade now. Credit for the unused part of {plan.name} ({inr(preview.creditMinor)}) is taken off. Remaining {preview.daysLeft} of {preview.totalDays} days: {inr(preview.dueMinor)} plus GST = <strong>{inr(preview.grossMinor)}</strong> due now.</p>
                ) : preview.mode === "SCHEDULE" ? (
                  <p className="mt-1">This takes effect {preview.effective}. Nothing is charged today, and your current plan stays until then.</p>
                ) : (
                  <p className="mt-1">First invoice: {inr(preview.dueMinor)} plus GST = <strong>{inr(preview.grossMinor)}</strong>. Your plan starts once the payment is recorded.</p>
                )}
                {preview.blockers.length === 0 && (
                  <form action={changePlanAction} className="mt-2 flex gap-2">
                    <input type="hidden" name="planCode" value={preview.plan.code} />
                    <input type="hidden" name="interval" value={preview.interval} />
                    <button className={btn}>{preview.mode === "UPGRADE" ? "Upgrade now" : preview.mode === "SCHEDULE" ? "Schedule this change" : "Create invoice"}</button>
                    <Link className={btnGhost} href="/app/settings/subscription">Not now</Link>
                  </form>
                )}
              </div>
            )}
            {previewError && <Notice tone="warn">{previewError}</Notice>}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className={thead}><tr><th className="p-2">Plan</th><th>Monthly</th><th>Yearly</th><th>Limits</th><th /></tr></thead>
                <tbody className="divide-y">
                  {o.plans.map((p) => (
                    <tr key={p.id}>
                      <td className="p-2 font-medium">{p.name}{p.id === plan.id ? " (current)" : ""}</td>
                      <td>{p.customPricing ? `From ${inr(p.monthlyPriceMinor)}` : inr(p.monthlyPriceMinor)}</td>
                      <td>{p.customPricing ? "Contact sales" : inr(planPrice(p, "ANNUAL"))}</td>
                      <td className="text-xs text-slate-700">{limitText(p.maxProperties, "property", "properties")}, {limitText(p.maxRooms, "room", "rooms")}, {limitText(p.maxUsers, "user", "users")}</td>
                      <td className="space-x-1 whitespace-nowrap text-right">
                        {p.customPricing ? <Link className={btnGhost} href="/contact">Contact sales</Link> : (
                          <>
                            <Link className={btnGhost} href={`/app/settings/subscription?preview=${p.code}&interval=MONTHLY`}>Monthly</Link>
                            <Link className={btnGhost} href={`/app/settings/subscription?preview=${p.code}&interval=ANNUAL`}>Yearly</Link>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-600">Upgrades start now and you pay only for the days left in this period, after credit for what you did not use. Downgrades start at your next renewal and are only allowed when you are within the smaller plan&apos;s limits.</p>
            <form action={applyCouponAction} className="mt-4 flex max-w-sm items-end gap-2">
              <div className="flex-1"><Field label="Coupon code"><input name="code" className={`${input} uppercase`} autoComplete="off" /></Field></div>
              <button className={btnGhost}>Apply</button>
            </form>
          </Card>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="What your plan includes">
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f.key} className={hasFeature(plan, f.key) ? "text-slate-900" : "text-slate-500 line-through"}>{hasFeature(plan, f.key) ? "Included: " : "Not included: "}{f.label}</li>
            ))}
          </ul>
        </Card>
        <Card title="Invoices">
          {o.invoices.length === 0 ? <p className="text-sm text-slate-600">No invoices yet.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className={thead}><tr><th className="p-2">Number</th><th>Date</th><th className="text-right">Total</th><th>Status</th><th /></tr></thead>
              <tbody className="divide-y">
                {o.invoices.map((i) => (
                  <tr key={i.id}><td className="p-2 font-mono text-xs">{i.number}</td><td>{fmtDate(i.issuedAt)}</td><td className="text-right">{inr(i.grossMinor)}</td><td>{i.status === "OPEN" ? "Unpaid" : i.status === "PAID" ? "Paid" : "Cancelled"}</td><td><a className="text-brand-700 hover:underline" href={`/app/settings/subscription/invoice/${i.id}`}>PDF</a></td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Payments">
          {o.payments.length === 0 ? <p className="text-sm text-slate-600">No payments recorded yet.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className={thead}><tr><th className="p-2">Date</th><th>Method</th><th>Reference</th><th className="text-right">Amount</th></tr></thead>
              <tbody className="divide-y">
                {o.payments.map((p) => (
                  <tr key={p.id}><td className="p-2">{fmtDate(p.createdAt)}</td><td>{p.method.replaceAll("_", " ").toLowerCase()}{p.status === "FAILED" ? " (failed)" : ""}</td><td>{p.reference || "-"}</td><td className="text-right">{inr(p.amountMinor)}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
        <Card title="History">
          <ul className="space-y-1 text-sm">
            {o.events.map((e) => <li key={e.id}><span className="text-slate-600">{fmtDate(e.createdAt)}</span> {e.type.replaceAll(".", " ").replaceAll("_", " ")}</li>)}
          </ul>
        </Card>
      </div>
    </>
  );
}
