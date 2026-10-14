import Link from "next/link";
import { updatePropertyAction } from "@/app/account-actions";
import { addBuildingAction, addFloorAction, addRoomTypeAction, wizardFinishAction, wizardStepAction } from "@/app/actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { listStructure } from "@/server/services/structure";
import { listRoomTypes } from "@/server/services/rooms";
import { getOnboarding, WIZARD_STEPS } from "@/server/services/onboarding";
import { getCtx } from "@/server/session";

const link = "font-medium text-brand-700 underline";

export default async function Onboarding({ searchParams }: PageProps<"/onboarding">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const { state, property: p, counts } = await getOnboarding(getDb(), ctx);
  const raw = typeof sp.step === "string" ? Number(sp.step) : state.step;
  const step = Number.isInteger(raw) && raw >= 0 && raw < WIZARD_STEPS.length ? raw : 0;
  const buildings = step === 1 ? await listStructure(getDb(), ctx) : [];
  const types = step === 2 ? await listRoomTypes(getDb(), ctx) : [];
  const done = [!!p.address, counts.buildings > 0 && counts.floors > 0, counts.types > 0, counts.rooms > 0, counts.placed > 0, !!state.completedAt];

  const nav = (to: number, label: string, primary = false) => (
    <form action={wizardStepAction}>
      <input type="hidden" name="step" value={to} />
      <button className={primary ? btn : btnGhost}>{label}</button>
    </form>
  );

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Set up your property</h1>
      <p className="text-sm text-slate-600">Your progress is saved. You can leave and come back to this page at any time.</p>
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />
      {typeof sp.ok === "string" && <p role="status" className="text-sm text-green-800">{sp.ok}</p>}

      <nav aria-label="Setup progress">
        <ol className="flex flex-wrap gap-2 text-xs">
          {WIZARD_STEPS.map((label, i) => (
            <li key={label}>
              <Link href={`/onboarding?step=${i}`} aria-current={i === step ? "step" : undefined}
                className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 ${i === step ? "border-brand-700 bg-brand-50 font-semibold" : "border-slate-300"}`}>
                <span aria-hidden>{done[i] ? "✓" : i + 1}</span>
                <span>{label}</span>
                <span className="sr-only">{done[i] ? " (done)" : " (to do)"}</span>
              </Link>
            </li>
          ))}
        </ol>
        <div className="mt-2 h-1.5 rounded bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={WIZARD_STEPS.length} aria-valuenow={done.filter(Boolean).length} aria-label="Steps completed">
          <div className="h-full rounded bg-brand-700" style={{ width: `${(done.filter(Boolean).length / WIZARD_STEPS.length) * 100}%` }} />
        </div>
      </nav>

      <Card title={`Step ${step + 1} of ${WIZARD_STEPS.length}: ${WIZARD_STEPS[step]}`}>
        {step === 0 && (
          <form id="property" action={updatePropertyAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Property name"><input name="name" defaultValue={p.name} required className={input} /></Field>
            <Field label="Timezone"><input name="timezone" defaultValue={p.timezone} required className={input} /></Field>
            <div className="sm:col-span-2"><Field label="Address"><input name="address" defaultValue={p.address ?? ""} className={input} /></Field></div>
            <Field label="Check-in time"><input name="checkInTime" type="time" defaultValue={p.checkInTime} required className={input} /></Field>
            <Field label="Check-out time"><input name="checkOutTime" type="time" defaultValue={p.checkOutTime} required className={input} /></Field>
            <div className="sm:col-span-2 text-xs text-slate-500">Contact details, GST registration and invoice settings are under <Link className={link} href="/app/settings">Settings</Link>.</div>
            <div><button className={btn}>Save</button></div>
          </form>
        )}
        {step === 1 && (
          <div className="space-y-4 text-sm">
            <p>{counts.buildings} building(s), {counts.floors} floor(s) defined. One building is enough for most hotels.</p>
            <ul className="divide-y">
              {buildings.filter((b) => b.active).map((b) => (
                <li key={b.id} className="py-1"><strong>{b.name}</strong>: {b.floors.filter((f) => f.active).map((f) => f.label).join(", ") || "no floors yet"}</li>
              ))}
            </ul>
            <form action={addBuildingAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="back" value="/onboarding?step=1" />
              <Field label="New building or wing"><input name="name" required maxLength={80} placeholder="Main Building" className={input} /></Field>
              <button className={btn}>Add building</button>
            </form>
            {buildings.some((b) => b.active) && (
              <form action={addFloorAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="back" value="/onboarding?step=1" />
                <Field label="Building">
                  <select name="buildingId" required className={input}>{buildings.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                </Field>
                <Field label="Floor name"><input name="label" required maxLength={80} placeholder="Floor 1" className={input} /></Field>
                <Field label="Level"><input name="level" type="number" min={-5} max={200} defaultValue={0} className={input} /></Field>
                <button className={btn}>Add floor</button>
              </form>
            )}
            <p className="text-xs text-slate-500">Reordering and deactivating are under <Link className={link} href="/app/structure">Buildings &amp; floors</Link>.</p>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-4 text-sm">
            <p>{counts.types} room categor{counts.types === 1 ? "y" : "ies"} defined.</p>
            <ul className="divide-y">{types.map((t) => <li key={t.id} className="py-1">{t.name} <span className="text-slate-500">({t.maxAdults}A/{t.maxChildren}C{t.bedConfig ? `, ${t.bedConfig}` : ""})</span></li>)}</ul>
            <form action={addRoomTypeAction} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="back" value="/onboarding?step=2" />
              <Field label="Category name"><input name="name" required maxLength={80} placeholder="Deluxe" className={input} /></Field>
              <Field label="Default rate (₹ per night)"><input name="baseRate" type="number" min={0} step="0.01" className={input} /></Field>
              <Field label="Standard occupancy"><input name="baseOccupancy" type="number" min={1} defaultValue={2} className={input} /></Field>
              <Field label="Max adults"><input name="maxAdults" type="number" min={1} defaultValue={2} className={input} /></Field>
              <Field label="Max children"><input name="maxChildren" type="number" min={0} defaultValue={0} className={input} /></Field>
              <Field label="Bed configuration"><input name="bedConfig" placeholder="1 King or 2 Twin" className={input} /></Field>
              <div className="sm:col-span-2"><Field label="Amenities (comma separated)"><input name="amenities" placeholder="AC, WiFi, TV" className={input} /></Field></div>
              <div><button className={btn}>Add category</button></div>
            </form>
            <p className="text-xs text-slate-500">Extra-person rates and descriptions are under <Link className={link} href="/app/room-types">Room types</Link>.</p>
          </div>
        )}
        {step === 3 && (
          <div className="space-y-2 text-sm">
            <p>{counts.rooms} room(s) added.</p>
            <p><Link className={link} href="/app/rooms">Add rooms one by one</Link> or <Link className={link} href="/app/rooms/import">import from CSV / Excel</Link>.</p>
          </div>
        )}
        {step === 4 && (
          <div className="space-y-2 text-sm">
            <p>{counts.placed} of {counts.rooms} room(s) placed on a floor plan. This step is optional.</p>
            <p><Link className={link} href="/app/rooms/plan">Open the floor plan</Link>.</p>
          </div>
        )}
        {step === 5 && (
          <div className="space-y-3 text-sm">
            <h2 className="font-medium">Review</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              <dt className="text-slate-500">Property</dt><dd className="sm:col-span-2">{p.name}</dd>
              <dt className="text-slate-500">Address</dt><dd className="sm:col-span-2">{p.address ?? "Not set"}</dd>
              <dt className="text-slate-500">Check-in / out</dt><dd className="sm:col-span-2">{p.checkInTime} / {p.checkOutTime} ({p.timezone})</dd>
              <dt className="text-slate-500">Buildings / floors</dt><dd className="sm:col-span-2">{counts.buildings} / {counts.floors}</dd>
              <dt className="text-slate-500">Room categories</dt><dd className="sm:col-span-2">{counts.types}</dd>
              <dt className="text-slate-500">Rooms</dt><dd className="sm:col-span-2">{counts.rooms} ({counts.placed} on the floor plan)</dd>
            </dl>
            {state.completedAt && <p role="status" className="text-green-800">Setup was completed. You can still change anything later.</p>}
            <form action={wizardFinishAction}><button className={btn}>{state.completedAt ? "Back to dashboard" : "Confirm and finish setup"}</button></form>
          </div>
        )}
        <div className="mt-4 flex gap-2 border-t pt-3">
          {step > 0 && nav(step - 1, "Back")}
          {step < WIZARD_STEPS.length - 1 && nav(step + 1, "Next", true)}
          <Link href="/app/dashboard" className="ml-auto self-center text-xs text-slate-500 underline">Skip for now</Link>
        </div>
      </Card>
    </main>
  );
}
