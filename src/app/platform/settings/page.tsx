import { saveSettingsAction } from "@/app/platform-actions";
import { btn, Card, ErrorBanner, Field, input, Notice, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { requirePlatform } from "@/server/platform";
import { readPlatformSettings } from "@/server/services/platform";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PlatformSettings({ searchParams }: PageProps<"/platform/settings">) {
  const sp = await searchParams;
  const p = await requirePlatform();
  const write = p.role === "PLATFORM_SUPER_ADMIN";
  const s = await readPlatformSettings(getDb(), p);
  const plans = await getDb().plan.findMany({ where: { active: true, customPricing: false }, orderBy: { sortOrder: "asc" } });
  return (
    <>
      <PageHeader title="Platform settings" subtitle="Your own company details, tax, payment instructions and the renewal rules." />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}
      <Notice tone="warn">The tax rate and SAC code on subscription invoices are yours to set. Have your accountant confirm them. Hotel guest billing is separate and unaffected.</Notice>
      <form action={saveSettingsAction} className="space-y-4">
        <fieldset disabled={!write} className="space-y-4">
          <Card title="Your company (shown on subscription invoices)">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Legal name"><input name="legalName" required defaultValue={s["saas.legalName"]} className={input} /></Field>
              <Field label="GSTIN"><input name="gstin" maxLength={15} defaultValue={s["saas.gstin"]} className={`${input} font-mono uppercase`} /></Field>
              <Field label="State code (2 digits)"><input name="stateCode" maxLength={2} defaultValue={s["saas.stateCode"]} className={input} /></Field>
              <Field label="SAC code for the service"><input name="sacCode" maxLength={10} defaultValue={s["saas.sacCode"]} className={input} /></Field>
              <div className="sm:col-span-2"><Field label="Address"><input name="address" defaultValue={s["saas.address"]} className={input} /></Field></div>
              <Field label="GST rate on subscriptions (%)"><input name="gstPct" type="number" step="0.01" min={0} max={50} defaultValue={s["saas.gstBps"] / 100} className={input} /></Field>
              <Field label="Invoice number prefix"><input name="invoicePrefix" required defaultValue={s["saas.invoicePrefix"]} className={`${input} uppercase`} /></Field>
              <div className="sm:col-span-2"><Field label="How hotels pay (bank account, UPI id). Shown on invoices and the subscription page"><textarea name="paymentInstructions" rows={4} defaultValue={s["saas.paymentInstructions"]} className={input} /></Field></div>
              <Field label="Sales email (new leads are sent here)"><input name="salesEmail" type="email" defaultValue={s["saas.salesEmail"]} className={input} /></Field>
            </div>
          </Card>
          <Card title="Trials and renewals">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Default trial days"><input name="defaultTrialDays" type="number" min={0} max={90} defaultValue={s["saas.defaultTrialDays"]} className={input} /></Field>
              <Field label="Plan new sign-ups start on">
                <select name="defaultPlanCode" defaultValue={s["saas.defaultPlanCode"]} className={input}>{plans.map((pl) => <option key={pl.id} value={pl.code}>{pl.name}</option>)}</select>
              </Field>
              <Field label="Renewal invoice, days before the end"><input name="renewalLeadDays" type="number" min={1} max={60} defaultValue={s["saas.renewalLeadDays"]} className={input} /></Field>
              <Field label="Grace days after the end"><input name="graceDays" type="number" min={0} max={60} defaultValue={s["saas.graceDays"]} className={input} /></Field>
              <Field label="Days suspended before expiry"><input name="expireAfterSuspendedDays" type="number" min={1} max={365} defaultValue={s["saas.expireAfterSuspendedDays"]} className={input} /></Field>
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" name="pastDueReadOnly" defaultChecked={s["saas.pastDueReadOnly"]} /> Make accounts read-only as soon as payment is overdue</label>
            </div>
            <p className="mt-2 text-xs text-slate-600">Nothing is ever deleted when a subscription lapses. Suspended and expired accounts are read-only and can still export their data.</p>
          </Card>
        </fieldset>
        {write && <button className={btn}>Save settings</button>}
      </form>
    </>
  );
}
