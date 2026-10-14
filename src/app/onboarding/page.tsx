import Link from "next/link";
import { updatePropertyAction } from "@/app/account-actions";
import { wizardFinishAction, wizardStepAction } from "@/app/actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getOnboarding, WIZARD_STEPS } from "@/server/services/onboarding";
import { getCtx } from "@/server/session";

const link = "font-medium text-indigo-700 underline";

export default async function Onboarding({ searchParams }: PageProps<"/onboarding">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const { state, property: p, counts } = await getOnboarding(getDb(), ctx);
  const raw = typeof sp.step === "string" ? Number(sp.step) : state.step;
  const step = Number.isInteger(raw) && raw >= 0 && raw < WIZARD_STEPS.length ? raw : 0;
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
                className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 ${i === step ? "border-indigo-700 bg-indigo-50 font-semibold" : "border-slate-300"}`}>
                <span aria-hidden>{done[i] ? "✓" : i + 1}</span>
                <span>{label}</span>
                <span className="sr-only">{done[i] ? " (done)" : " (to do)"}</span>
              </Link>
            </li>
          ))}
        </ol>
        <div className="mt-2 h-1.5 rounded bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={WIZARD_STEPS.length} aria-valuenow={done.filter(Boolean).length} aria-label="Steps completed">
          <div className="h-full rounded bg-indigo-700" style={{ width: `${(done.filter(Boolean).length / WIZARD_STEPS.length) * 100}%` }} />
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
          <div className="space-y-2 text-sm">
            <p>{counts.buildings} building(s), {counts.floors} floor(s) defined.</p>
            <p>A single building is enough for most hotels. <Link className={link} href="/app/structure">Open Buildings &amp; floors</Link>.</p>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-2 text-sm">
            <p>{counts.types} room categor{counts.types === 1 ? "y" : "ies"} defined.</p>
            <p>Set occupancy, bed configuration, amenities and the default rate. <Link className={link} href="/app/room-types">Open Room types</Link>.</p>
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
