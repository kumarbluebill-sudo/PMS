import Link from "next/link";
import { saveRatePlanAction } from "@/app/property-actions";
import { btn, btnGhost, Field, input } from "@/app/ui";
import UnsavedGuard from "@/components/UnsavedGuard";
import { MEAL_LABELS, MEAL_PLANS, WEEKDAY_NAMES } from "@/server/domain/rates";

type Line = { roomTypeId: string; weekdayRateMinor: number; weekendRateMinor: number | null; singleOccupancyRateMinor: number | null; extraAdultRateMinor: number | null; extraChildRateMinor: number | null };
export type PlanFormPlan = {
  id: string; name: string; code: string; description: string | null; active: boolean; validFrom: Date | null; validTo: Date | null; priority: number; weekendDays: number[];
  mealPlan: string; refundable: boolean; minStay: number | null; maxStay: number | null; taxNote: string | null; updatedAt: Date; rates: Line[];
};

const rupees = (m: number | null | undefined) => (m === null || m === undefined ? "" : (m / 100).toFixed(2));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

/** One form for creating and editing a plan. Rates are entered in rupees, before tax; a blank weekday rate leaves a category out. */
export default function RatePlanForm({ plan, types }: { plan?: PlanFormPlan; types: { id: string; name: string; baseRateMinor: number; active?: boolean }[] }) {
  const line = (id: string) => plan?.rates.find((r) => r.roomTypeId === id);
  const weekend = plan?.weekendDays ?? [5, 6];
  const usable = types.filter((t) => t.active !== false || line(t.id));
  return (
    <form id="plan-form" action={saveRatePlanAction} className="space-y-4">
      {plan && <input type="hidden" name="id" value={plan.id} />}
      {plan && <input type="hidden" name="expectedUpdatedAt" value={plan.updatedAt.toISOString()} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Plan name"><input name="name" defaultValue={plan?.name} required maxLength={80} placeholder="Festival season" className={input} /></Field>
        <Field label="Code"><input name="code" defaultValue={plan?.code} required maxLength={20} placeholder="FEST" className={input} /></Field>
        <Field label="Valid from (blank = always)"><input name="validFrom" type="date" defaultValue={day(plan?.validFrom)} className={input} /></Field>
        <Field label="Valid to (blank = no end)"><input name="validTo" type="date" defaultValue={day(plan?.validTo)} className={input} /></Field>
        <Field label="Priority (higher wins an overlap)"><input name="priority" type="number" min={0} max={100} defaultValue={plan?.priority ?? 0} className={input} /></Field>
        <Field label="Meal plan">
          <select name="mealPlan" defaultValue={plan?.mealPlan ?? "ROOM_ONLY"} className={input}>{MEAL_PLANS.map((m) => <option key={m} value={m}>{MEAL_LABELS[m]}</option>)}</select>
        </Field>
        <Field label="Minimum stay (nights)"><input name="minStay" type="number" min={1} max={365} defaultValue={plan?.minStay ?? ""} className={input} /></Field>
        <Field label="Maximum stay (nights)"><input name="maxStay" type="number" min={1} max={365} defaultValue={plan?.maxStay ?? ""} className={input} /></Field>
      </div>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <legend className="mb-1 text-sm font-medium text-slate-700">Weekend rate applies on</legend>
        {WEEKDAY_NAMES.map((n, i) => <label key={n} className="flex items-center gap-1.5"><input type="checkbox" name="weekend" value={i} defaultChecked={weekend.includes(i)} />{n}</label>)}
      </fieldset>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="refundable" defaultChecked={plan?.refundable ?? true} /> Refundable</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={plan?.active ?? true} /> Active</label>
      </div>
      <Field label="Description (optional)"><textarea name="description" rows={2} maxLength={500} defaultValue={plan?.description ?? ""} className={input} /></Field>
      <Field label="Tax note (optional, shown to staff only)"><input name="taxNote" maxLength={300} defaultValue={plan?.taxNote ?? ""} placeholder="GST is added from the tax rules; rates here are before tax" className={input} /></Field>

      <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Rates by category, scrolls sideways">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="mb-1 text-left text-sm font-medium text-slate-700">Rates per night in rupees, before GST. Leave the weekday rate blank to leave a category out of this plan.</caption>
          <thead className="text-xs text-slate-600">
            <tr><th scope="col" className="py-1 pr-2">Category</th><th scope="col" className="pr-2">Weekday</th><th scope="col" className="pr-2">Weekend</th><th scope="col" className="pr-2">One adult</th><th scope="col" className="pr-2">Extra adult</th><th scope="col">Extra child</th></tr>
          </thead>
          <tbody className="divide-y">
            {usable.map((t) => {
              const l = line(t.id);
              const cell = (name: string, v: number | null | undefined, label: string) => (
                <td className="pr-2"><input name={`${name}_${t.id}`} inputMode="decimal" defaultValue={rupees(v)} aria-label={`${label} for ${t.name}`} className={`${input} w-24`} /></td>
              );
              return (
                <tr key={t.id}>
                  <th scope="row" className="py-1.5 pr-2 font-medium">{t.name}<input type="hidden" name="typeIds" value={t.id} /><span className="block text-xs font-normal text-slate-600">default {rupees(t.baseRateMinor)}</span></th>
                  {cell("weekday", l?.weekdayRateMinor, "Weekday rate")}{cell("weekend", l?.weekendRateMinor, "Weekend rate")}{cell("single", l?.singleOccupancyRateMinor, "One-adult rate")}
                  {cell("extraAdult", l?.extraAdultRateMinor, "Extra adult")}{cell("extraChild", l?.extraChildRateMinor, "Extra child")}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-600">Blank weekend, one-adult, extra adult or extra child cells use the weekday rate, the weekday rate, and the category&rsquo;s own extra-person rates. Saving never changes bookings that already exist.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button className={btn}>{plan ? "Save changes" : "Create rate plan"}</button>
        <Link href="/app/rates" className={btnGhost}>Back to rate plans</Link>
        <UnsavedGuard formId="plan-form" />
      </div>
    </form>
  );
}
