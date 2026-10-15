import type { Plan } from "@prisma/client";
import { saveAddonAction, savePlanAction } from "@/app/platform-actions";
import { btn, Card, ErrorBanner, Field, input, Notice, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { FEATURES, hasFeature } from "@/server/domain/subscription";
import { requirePlatform } from "@/server/platform";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const rupees = (minor: number | null | undefined) => (minor == null ? "" : String(minor / 100));
const num = (n: number | null | undefined) => (n == null ? "" : String(n));

function PlanForm({ plan, write }: { plan?: Plan; write: boolean }) {
  return (
    <form action={savePlanAction} className="space-y-3">
      <fieldset disabled={!write} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code (letters, numbers, dashes)"><input name="code" required defaultValue={plan?.code} readOnly={!!plan} className={input} /></Field>
          <Field label="Name"><input name="name" required defaultValue={plan?.name} className={input} /></Field>
          <Field label="Order on the pricing page"><input name="sortOrder" type="number" defaultValue={plan?.sortOrder ?? 0} className={input} /></Field>
        </div>
        <Field label="Short description"><input name="description" defaultValue={plan?.description} className={input} /></Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Monthly price (rupees, before GST)"><input name="monthlyPrice" inputMode="decimal" defaultValue={rupees(plan?.monthlyPriceMinor)} className={input} /></Field>
          <Field label="Yearly price (blank = from discount)"><input name="annualPrice" inputMode="decimal" defaultValue={rupees(plan?.annualPriceMinor)} className={input} /></Field>
          <Field label="Yearly discount (%)"><input name="annualDiscountPct" type="number" step="0.01" min={0} max={100} defaultValue={plan ? plan.annualDiscountBps / 100 : 16.67} className={input} /></Field>
          <Field label="Trial days"><input name="trialDays" type="number" min={0} max={90} defaultValue={plan?.trialDays ?? 14} className={input} /></Field>
        </div>
        <p className="text-xs text-slate-600">Limits: leave blank for unlimited.</p>
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Properties"><input name="maxProperties" type="number" min={0} defaultValue={num(plan?.maxProperties)} className={input} /></Field>
          <Field label="Rooms"><input name="maxRooms" type="number" min={0} defaultValue={num(plan?.maxRooms)} className={input} /></Field>
          <Field label="Users"><input name="maxUsers" type="number" min={0} defaultValue={num(plan?.maxUsers)} className={input} /></Field>
          <Field label="Storage (MB)"><input name="maxStorageMb" type="number" min={0} defaultValue={num(plan?.maxStorageMb)} className={input} /></Field>
          <Field label="Integrations"><input name="maxIntegrations" type="number" min={0} defaultValue={num(plan?.maxIntegrations)} className={input} /></Field>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={plan?.active ?? true} /> Active</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="isPublic" defaultChecked={plan?.isPublic ?? true} /> Shown on the pricing page</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="customPricing" defaultChecked={plan?.customPricing ?? false} /> Custom pricing (contact sales)</label>
        </div>
        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium">Features</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm"><input type="checkbox" name={`f_${f.key}`} defaultChecked={plan ? hasFeature(plan, f.key) : false} /> {f.label}</label>
            ))}
          </div>
        </fieldset>
        {write && <button className={btn}>{plan ? "Save plan" : "Add plan"}</button>}
      </fieldset>
    </form>
  );
}

export default async function Plans({ searchParams }: PageProps<"/platform/plans">) {
  const sp = await searchParams;
  const p = await requirePlatform();
  const write = p.role === "PLATFORM_SUPER_ADMIN";
  const [plans, addons] = await Promise.all([getDb().plan.findMany({ orderBy: { sortOrder: "asc" } }), getDb().planAddon.findMany({ orderBy: { code: "asc" } })]);
  return (
    <>
      <PageHeader title="Plans and add-ons" subtitle="Prices, limits and features. The pricing page and the sign-up trial read these rows; nothing is hardcoded." />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}
      {!write && <Notice tone="info">Support staff can view plans but not change them.</Notice>}
      <div className="space-y-4">
        {plans.map((pl) => (
          <Card key={pl.id} title={`${pl.name}${pl.active ? "" : " (inactive)"}`}><PlanForm plan={pl} write={write} /></Card>
        ))}
        {write && <Card title="Add a plan"><PlanForm write /></Card>}
        <Card title="Add-ons">
          <ul className="mb-3 space-y-1 text-sm">
            {addons.map((a) => <li key={a.id}>{a.name} ({a.code}): Rs. {a.monthlyPriceMinor / 100} per month{a.active ? "" : ", inactive"}</li>)}
            {addons.length === 0 && <li className="text-slate-600">No add-ons yet.</li>}
          </ul>
          {write && (
            <form action={saveAddonAction} className="grid gap-3 sm:grid-cols-4">
              <Field label="Code"><input name="code" required className={input} /></Field>
              <Field label="Name"><input name="name" required className={input} /></Field>
              <Field label="Monthly price (rupees)"><input name="monthlyPrice" inputMode="decimal" required className={input} /></Field>
              <Field label="Description"><input name="description" className={input} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked /> Active</label>
              <div className="sm:col-span-3"><button className={btn}>Save add-on</button></div>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
