import Link from "next/link";
import { wizardConfirmAction, wizardLegalAction, wizardPresetAction, wizardPricingModeAction, wizardPrefixAction, wizardRuleAction } from "@/app/tax-setup-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { financialYear, GST_STATES, validateGstin } from "@/server/domain/gst";
import { OWN_RULE_CATEGORIES } from "@/server/domain/gstPresets";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { gstSetupStatus, listRules, presetsWithStatus, previewTax } from "@/server/services/tax";
import { settingsFor } from "@/server/services/settings";

const STEPS = [
  "Country and currency", "Legal details and registration", "GSTIN", "State and location", "Accommodation rules",
  "Other services", "Default pricing", "Invoice series", "Preview", "Review and confirm",
];
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function TaxSetup({ searchParams }: PageProps<"/app/settings/tax/setup">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const step = Math.min(10, Math.max(1, Number(one(sp.step)) || 1));
  const [status, st, rules] = await Promise.all([gstSetupStatus(db, ctx), settingsFor(db, ctx), listRules(db, ctx)]);
  const p = status.property;
  const nav = (n: number) => `/app/settings/tax/setup?step=${n}`;

  return (
    <>
      <Breadcrumbs items={[{ label: "Settings", href: "/app/settings" }, { label: "GST and tax", href: "/app/settings/tax" }, { label: "Setup wizard" }]} />
      <PageHeader title="GST setup" subtitle={`Step ${step} of ${STEPS.length}: ${STEPS[step - 1]}`} />
      <div role="note" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        Tax rules depend on the supply, the date and your registration. Rules added here are drafts that a second authorised person approves, and your accountant or a qualified tax professional must verify them against the official notifications before you issue real invoices. This system does not file returns and does not check your GSTIN with the government portal.
      </div>
      <ol aria-label="Setup steps" className="mb-4 flex flex-wrap gap-1.5 text-xs">
        {STEPS.map((t, i) => (
          <li key={t}><Link href={nav(i + 1)} aria-current={i + 1 === step ? "step" : undefined} className={`block rounded-full border px-2.5 py-1 ${i + 1 === step ? "border-brand-700 bg-brand-50 font-semibold text-brand-900" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}>{i + 1}. {t}</Link></li>
        ))}
      </ol>
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      {step === 1 && (
        <Card title="Country and currency">
          <p className="text-sm text-slate-800">This system bills in <strong>Indian rupees (INR)</strong> under <strong>Indian GST</strong>. No other country or currency is supported yet.</p>
          <p className="mt-2 text-sm text-slate-700">Invoices, the tax engine and reports all use INR.</p>
        </Card>
      )}

      {step === 2 && (
        <Card title="Legal details and GST registration">
          <form action={wizardLegalAction} className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="gstRegistered" defaultChecked={p.gstRegistered} /> This hotel is registered under GST</label>
            <Field label="Legal name (as on the registration)"><input name="legalName" defaultValue={p.legalName ?? ""} className={input} /></Field>
            <Field label="GSTIN (if registered)"><input name="gstin" defaultValue={p.gstin ?? ""} maxLength={15} className={`${input} font-mono uppercase`} /></Field>
            <div className="sm:col-span-2"><Field label="Registered address"><input name="address" defaultValue={p.address ?? ""} className={input} /></Field></div>
            <input type="hidden" name="invoicePrefix" value={p.invoicePrefix} />
            <p className="text-xs text-slate-700 sm:col-span-2">A hotel that is not registered issues a Bill of Supply and charges no GST. A registered hotel needs a valid GSTIN, its legal name and address on every invoice.</p>
            <div className="sm:col-span-2"><button className={btn}>Save and continue</button></div>
          </form>
        </Card>
      )}

      {step === 3 && (() => {
        const entered = one(sp.gstin) || p.gstin || "";
        const v = entered ? validateGstin(entered) : null;
        return (
          <Card title="Check a GSTIN">
            <form method="get" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="step" value="3" />
              <Field label="GSTIN to check"><input name="gstin" defaultValue={entered} maxLength={15} className={`${input} font-mono uppercase`} /></Field>
              <button className={btnGhost}>Check format</button>
            </form>
            {v && (v.ok
              ? <p role="status" className="mt-3 rounded border border-green-300 bg-green-50 p-2 text-sm text-green-950">The format and check digit are valid. State: {GST_STATES[v.stateCode]} ({v.stateCode}). This does not confirm the number is registered; verify it on the government portal.</p>
              : <p role="alert" className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-950">{v.reason}</p>)}
            {!entered && <p className="mt-3 text-sm text-slate-700">Enter a GSTIN to check it. Save it in step 2.</p>}
          </Card>
        );
      })()}

      {step === 4 && (
        <Card title="State and business location">
          <dl className="grid grid-cols-[11rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-700">State (from the GSTIN)</dt><dd>{p.gstStateCode ? `${GST_STATES[p.gstStateCode]} (${p.gstStateCode})` : "Not set. Save a valid GSTIN in step 2."}</dd>
            <dt className="text-slate-700">Registered address</dt><dd>{p.address ?? "Not set"}</dd>
            <dt className="text-slate-700">Place of supply</dt><dd>For accommodation, the hotel&rsquo;s own state, so guests are charged CGST and SGST. Other categories can use the recipient&rsquo;s state (IGST between states) when you add their rules.</dd>
          </dl>
          <p className="mt-3 text-sm text-slate-700">Operational address, phone and email are kept under <Link className="underline" href="/app/settings/property">Property settings</Link>.</p>
        </Card>
      )}

      {step === 5 && <AccommodationStep rules={rules} presets={await presetsWithStatus(db, ctx)} />}

      {step === 6 && (
        <Card title="Restaurant, banquet and other services">
          <p className="mb-3 text-sm text-slate-800">No rate is filled in for these. Add a draft rule for each category you charge, using the rate and SAC code your accountant gives you. Until a rule is approved, a charge in that category cannot be posted.</p>
          <ul className="mb-4 divide-y text-sm">
            {OWN_RULE_CATEGORIES.map((c) => {
              const own = rules.filter((r) => r.category === c.category && r.status !== "RETIRED");
              const ok = own.some((r) => r.status === "APPROVED");
              return (
                <li key={c.category} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span><strong>{c.label}</strong>{c.hint && <span className="block text-xs text-slate-700">{c.hint}</span>}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ok ? "bg-green-100 text-green-900" : own.length ? "bg-amber-100 text-amber-950" : "bg-slate-200 text-slate-900"}`}>{ok ? "Approved rule" : own.length ? "Draft, awaiting approval" : "No rule yet"}</span>
                </li>
              );
            })}
          </ul>
          <form action={wizardRuleAction} className="grid gap-3 sm:grid-cols-3">
            <Field label="Category"><select name="category" className={input}>{OWN_RULE_CATEGORIES.map((c) => <option key={c.category} value={c.category}>{c.label}</option>)}</select></Field>
            <Field label="Treatment"><select name="treatment" className={input}><option value="TAXABLE">Taxable</option><option value="EXEMPT">Exempt</option><option value="NIL_RATED">Nil-rated</option></select></Field>
            <Field label="Rate %"><input name="ratePercent" inputMode="decimal" defaultValue="0" className={input} /></Field>
            <Field label="SAC code"><input name="sacCode" inputMode="numeric" className={input} /></Field>
            <Field label="Place of supply"><select name="placeOfSupply" className={input}><option value="PROPERTY_STATE">Hotel&rsquo;s state</option><option value="RECIPIENT_STATE">Recipient&rsquo;s state</option></select></Field>
            <Field label="Effective from"><input name="effectiveFrom" type="date" required className={input} /></Field>
            <div className="sm:col-span-2"><Field label="Description"><input name="description" className={input} placeholder="e.g. Restaurant food and beverage" /></Field></div>
            <Field label="Legal reference (notification)"><input name="legalRef" className={input} /></Field>
            <div className="sm:col-span-3"><button className={btn}>Save draft rule</button></div>
          </form>
        </Card>
      )}

      {step === 7 && (
        <Card title="Default pricing mode">
          <form action={wizardPricingModeAction} className="space-y-3">
            <fieldset className="space-y-2 text-sm">
              <legend className="mb-1 font-medium">When staff post a charge, the amount they enter</legend>
              <label className="flex items-start gap-2"><input type="radio" name="mode" value="exclusive" defaultChecked={!st["billing.taxInclusiveDefault"]} className="mt-1" /><span><strong>excludes GST</strong>: GST is added on top.</span></label>
              <label className="flex items-start gap-2"><input type="radio" name="mode" value="inclusive" defaultChecked={st["billing.taxInclusiveDefault"]} className="mt-1" /><span><strong>includes GST</strong>: the amount is the total and GST is taken out of it.</span></label>
            </fieldset>
            <p className="text-xs text-slate-700">Staff can still change this for a single charge. Room rates in rate plans and categories are always before GST.</p>
            <button className={btn}>Save and continue</button>
          </form>
        </Card>
      )}

      {step === 8 && (
        <Card title="Invoice series and financial year">
          <p className="mb-3 text-sm text-slate-800">Invoice numbers run in order within a series and restart each financial year (April to March). The current financial year is <strong>{financialYear(status.today)}</strong>.</p>
          <SeriesList prefix={p.invoicePrefix} fy={financialYear(status.today)} />
          {status.invoicesIssued > 0
            ? <p className="mt-3 text-sm text-slate-800">{status.invoicesIssued} invoice(s) have been issued, so the prefix <strong>{p.invoicePrefix}</strong> is fixed.</p>
            : (
              <form action={wizardPrefixAction} className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="Invoice prefix (1 to 4 letters or digits)"><input name="invoicePrefix" defaultValue={p.invoicePrefix} maxLength={4} className={`${input} uppercase`} /></Field>
                <button className={btn}>Save and continue</button>
              </form>
            )}
        </Card>
      )}

      {step === 9 && await PreviewStep({ sp, status })}

      {step === 10 && (
        <Card title="Review and confirm">
          <ul className="space-y-1.5 text-sm" aria-label="Setup checklist">
            <Row ok={!p.gstRegistered || status.missing.length === 0} label={p.gstRegistered ? "Registration details" : "Not registered: no GST is charged"} detail={status.missing.length ? `Missing: ${status.missing.join(", ")}.` : p.gstRegistered ? `${p.legalName}, GSTIN ${p.gstin}` : "Bills of Supply are issued."} />
            <Row ok={!p.gstRegistered || status.accommodation.every((a) => a.covered)} label="Accommodation priced at every tariff today" detail={status.accommodation.map((a) => `${formatInr(a.tariffMinor)}: ${a.covered ? "covered" : "no approved rule"}`).join(" · ")} />
            <Row ok={status.draftRules === 0} label="Draft rules awaiting approval" detail={status.draftRules ? `${status.draftRules} draft rule(s) need a second authorised person to approve them.` : "None."} warn />
            <Row ok label={`Invoice prefix ${p.invoicePrefix}`} detail={`Financial year ${financialYear(status.today)}`} />
          </ul>
          {status.confirmedAt && <p className="mt-3 rounded border border-green-300 bg-green-50 p-2 text-sm text-green-950">Confirmed by {status.confirmedBy} on {status.confirmedAt.slice(0, 10)}. Confirm again after changing rules.</p>}
          <form action={wizardConfirmAction} className="mt-4 space-y-2">
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="reviewed" required className="mt-1" /> The hotel&rsquo;s accountant or a qualified tax professional has reviewed these registration details, rates, SAC codes and effective dates.</label>
            <button className={btn}>Confirm GST setup</button>
          </form>
        </Card>
      )}

      <div className="mt-4 flex justify-between">
        {step > 1 ? <Link href={nav(step - 1)} className={btnGhost}>Back</Link> : <span />}
        {step < STEPS.length ? <Link href={nav(step + 1)} className={btnGhost}>Skip to step {step + 1}</Link> : <Link href="/app/settings/tax" className={btnGhost}>Open GST rules</Link>}
      </div>
    </>
  );
}

function Row({ ok, label, detail, warn }: { ok: boolean; label: string; detail: string; warn?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${ok ? "bg-green-100 text-green-900" : warn ? "bg-amber-100 text-amber-950" : "bg-red-100 text-red-950"}`}>{ok ? "✓" : warn ? "!" : "✕"}</span>
      <span><span className="font-medium">{label}</span><span className="sr-only">{ok ? " (done)" : warn ? " (check)" : " (to do)"}</span><span className="block text-xs text-slate-700">{detail}</span></span>
    </li>
  );
}

type RuleRows = Awaited<ReturnType<typeof listRules>>;
function AccommodationStep({ rules, presets }: { rules: RuleRows; presets: Awaited<ReturnType<typeof presetsWithStatus>> }) {
  const room = rules.filter((r) => r.category === "ROOM" && r.status !== "RETIRED");
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "no end");
  return (
    <div className="space-y-4">
      <Card title="Start from a preset">
        <p className="mb-3 text-sm text-slate-800">Presets are starting points that add <strong>draft</strong> rules. Check each against the official notification, edit anything that differs, then have a second authorised person approve them.</p>
        <ul className="space-y-3">
          {presets.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-200 p-3">
              <p className="font-medium">{p.title}</p>
              <p className="text-sm text-slate-800">{p.summary}</p>
              <form action={wizardPresetAction} className="mt-2 flex items-center gap-3">
                <input type="hidden" name="presetId" value={p.id} />
                <button className={btnGhost} disabled={p.applied === p.rules.length}>{p.applied === p.rules.length ? "Already added" : "Add these draft rules"}</button>
                <span className="text-xs text-slate-700">{p.applied} of {p.rules.length} already in your rules</span>
              </form>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={`Accommodation rules (${room.length})`}>
        {room.length === 0 ? <p className="text-sm text-slate-700">No accommodation rule yet.</p> : (
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Accommodation rules, scrolls sideways">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-xs text-slate-700"><tr><th scope="col" className="py-1 pr-2">Per room per day</th><th scope="col" className="pr-2">GST</th><th scope="col" className="pr-2">Effective</th><th scope="col">Status</th></tr></thead>
              <tbody className="divide-y">
                {room.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 pr-2">{r.tariffMinMinor !== null || r.tariffMaxMinor !== null ? `${r.tariffMinMinor !== null ? formatInr(r.tariffMinMinor) : "₹0"} to ${r.tariffMaxMinor !== null ? formatInr(r.tariffMaxMinor - 1) : "no limit"}` : "any tariff"}</td>
                    <td className="pr-2">{r.treatment === "TAXABLE" ? `${r.rateBp / 100}%` : r.treatment.replace("_", " ").toLowerCase()}</td>
                    <td className="whitespace-nowrap pr-2 text-xs">{day(r.effectiveFrom)} to {day(r.effectiveTo)}</td>
                    <td><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "APPROVED" ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-950"}`}>{r.status.toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-sm"><Link className="underline" href="/app/settings/tax">Edit, approve or retire rules</Link></p>
      </Card>
    </div>
  );
}

async function SeriesList({ prefix, fy }: { prefix: string; fy: string }) {
  const ctx = await getCtx();
  const rows = await withTenant(getDb(), ctx.tenantId, (tx) => tx.invoiceSequence.findMany({ where: { propertyId: ctx.propertyId!, financialYear: fy } }));
  const next = (series: string) => rows.find((r) => r.series === series)?.next ?? 1;
  const list: [string, string][] = [[prefix, "Tax invoice"], [`${prefix}B`, "Bill of supply"], [`${prefix}C`, "Credit note"], [`${prefix}D`, "Debit note"]];
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Invoice series for this financial year</caption>
      <thead className="text-xs text-slate-700"><tr><th scope="col" className="py-1">Document</th><th scope="col">Series</th><th scope="col">Next number</th></tr></thead>
      <tbody className="divide-y">{list.map(([s, name]) => <tr key={s}><td className="py-1.5">{name}</td><td className="font-mono">{s}</td><td className="font-mono">{s}/{fy}/{String(next(s)).padStart(6, "0")}</td></tr>)}</tbody>
    </table>
  );
}

async function PreviewStep({ sp, status }: { sp: Record<string, string | string[] | undefined>; status: Awaited<ReturnType<typeof gstSetupStatus>> }) {
  const ctx = await getCtx();
  const tariff = Number(one(sp.tariff));
  const run = Number.isFinite(tariff) && tariff > 0;
  const q = { category: one(sp.category) || "ROOM", tariff: one(sp.tariff) || "6500", nights: one(sp.nights) || "2", date: one(sp.date) || status.today, mode: one(sp.mode) || "exclusive", state: one(sp.state) };
  const res = run ? await previewTax(getDb(), ctx, { category: q.category, tariffMinor: Math.round(tariff * 100), nights: Number(q.nights) || 1, inclusive: q.mode === "inclusive", date: q.date, recipientStateCode: /^\d{2}$/.test(q.state) ? q.state : undefined }).catch((e: Error) => ({ error: e.message })) : null;
  const ok = res && "totals" in res && res.totals ? res : null;
  return (
    <Card title="Try a calculation">
      <form method="get" className="grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="step" value="9" />
        <Field label="Category"><select name="category" defaultValue={q.category} className={input}>{["ROOM", ...OWN_RULE_CATEGORIES.map((c) => c.category)].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Price per unit per day (₹)"><input name="tariff" inputMode="decimal" defaultValue={q.tariff} className={input} /></Field>
        <Field label="Nights"><input name="nights" type="number" min={1} max={30} defaultValue={q.nights} className={input} /></Field>
        <Field label="Service date"><input name="date" type="date" defaultValue={q.date} className={input} /></Field>
        <Field label="Amount entered"><select name="mode" defaultValue={q.mode} className={input}><option value="exclusive">Without GST</option><option value="inclusive">With GST</option></select></Field>
        <Field label="Guest's state code (optional)"><input name="state" maxLength={2} defaultValue={q.state} placeholder="e.g. 27" className={input} /></Field>
        <div className="sm:col-span-3"><button className={btn}>Calculate</button></div>
      </form>
      {res && "error" in res && res.error && <p role="alert" className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-950">{res.error}</p>}
      {ok && (
        <div className="mt-3 space-y-2 text-sm" role="status">
          {!ok.registered && <p className="rounded border border-slate-300 bg-slate-50 p-2">This hotel is not registered for GST, so no tax is charged.</p>}
          {ok.usesDraft && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-950">This result uses draft rules that are not approved yet. It is a preview only.</p>}
          <table className="w-full text-left">
            <thead className="text-xs text-slate-700"><tr><th scope="col" className="py-1">Date</th><th scope="col" className="text-right">Rate</th><th scope="col" className="text-right">Taxable</th><th scope="col" className="text-right">CGST</th><th scope="col" className="text-right">SGST</th><th scope="col" className="text-right">IGST</th><th scope="col" className="text-right">Total</th></tr></thead>
            <tbody className="divide-y tabular-nums">
              {ok.lines.map((l) => <tr key={l.date}><td className="py-1">{l.date}</td><td className="text-right">{l.rateBp / 100}%</td><td className="text-right">{formatInr(l.netMinor)}</td><td className="text-right">{formatInr(l.cgstMinor)}</td><td className="text-right">{formatInr(l.sgstMinor)}</td><td className="text-right">{formatInr(l.igstMinor)}</td><td className="text-right">{formatInr(l.grossMinor)}</td></tr>)}
              <tr className="font-semibold"><td className="py-1">Total</td><td /><td className="text-right">{formatInr(ok.totals.netMinor)}</td><td className="text-right">{formatInr(ok.totals.cgstMinor)}</td><td className="text-right">{formatInr(ok.totals.sgstMinor)}</td><td className="text-right">{formatInr(ok.totals.igstMinor)}</td><td className="text-right">{formatInr(ok.totals.grossMinor)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-sm"><Link className="underline" href="/app/settings/invoice-design">See a sample invoice in your chosen design</Link></p>
    </Card>
  );
}
