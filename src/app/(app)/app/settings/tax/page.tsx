import Link from "next/link";
import { approveRuleAction, createRuleAction, deleteRuleAction, gstSettingsAction, retireRuleAction } from "@/app/billing-actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { GST_STATES } from "@/server/domain/gst";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { CATEGORIES } from "@/server/services/billing";
import { listRules } from "@/server/services/tax";

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

export default async function TaxSettings({ searchParams }: PageProps<"/app/settings/tax">) {
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const [rules, property] = await Promise.all([
    listRules(db, ctx),
    withTenant(db, ctx.tenantId, (tx) => tx.property.findUniqueOrThrow({ where: { id: ctx.propertyId! } })),
  ]);
  const canApprove = roleHasPermission(ctx.role, "tax.approve", ctx.extra);
  const badge = (s: string) => <Badge value={s === "APPROVED" ? "CHECKED_IN" : s === "RETIRED" ? "CANCELLED" : "NO_SHOW"} />;
  return (
    <>
      <PageHeader title="GST & tax settings" subtitle="Every rate is a rule your authorised staff enter and a different authorised user approves. Presets are available as starting points." actions={<Link href="/app/settings/tax/setup" className={btn}>Open the setup wizard</Link>} />
      <div role="note" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        This software is not GST-certified. Have a qualified GST professional verify your registration details, SAC codes, rates, tariff bands and effective dates before issuing real invoices.
      </div>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 text-sm text-green-800">{ok}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Property GST registration">
          <form action={gstSettingsAction} className="space-y-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="gstRegistered" defaultChecked={property.gstRegistered} /> Registered under GST</label>
            <Field label="GSTIN"><input name="gstin" defaultValue={property.gstin ?? ""} className={input} /></Field>
            <Field label="Legal name (as on registration)"><input name="legalName" defaultValue={property.legalName ?? ""} className={input} /></Field>
            <Field label="Registered address"><input name="address" defaultValue={property.address ?? ""} className={input} /></Field>
            <Field label="Invoice prefix (1-4 letters/digits; fixed once invoices exist)"><input name="invoicePrefix" defaultValue={property.invoicePrefix} className={input} /></Field>
            <Field label="Reason for this change"><input name="reason" required className={input} /></Field>
            <p className="text-xs text-slate-500">State: {property.gstStateCode ? `${GST_STATES[property.gstStateCode]} (${property.gstStateCode})` : "set from the GSTIN"}</p>
            <button className={btn}>Save</button>
          </form>
        </Card>
        <Card title="Add a tax rule (saved as draft)">
          <form action={createRuleAction} className="grid grid-cols-2 gap-2">
            <Field label="Category"><select name="category" className={input}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Treatment"><select name="treatment" className={input}><option>TAXABLE</option><option>EXEMPT</option><option>NIL_RATED</option></select></Field>
            <Field label="Rate %"><input name="ratePercent" inputMode="decimal" defaultValue="0" className={input} /></Field>
            <Field label="Cess %"><input name="cessPercent" inputMode="decimal" defaultValue="0" className={input} /></Field>
            <Field label="SAC code"><input name="sacCode" className={input} /></Field>
            <Field label="Place of supply"><select name="placeOfSupply" className={input}><option value="PROPERTY_STATE">Property state</option><option value="RECIPIENT_STATE">Recipient state</option></select></Field>
            <Field label="Tariff from ₹ (inclusive)"><input name="tariffMin" inputMode="decimal" className={input} /></Field>
            <Field label="Tariff up to ₹ (exclusive)"><input name="tariffMax" inputMode="decimal" className={input} /></Field>
            <Field label="Effective from"><input name="effectiveFrom" type="date" required className={input} /></Field>
            <Field label="Effective to (exclusive)"><input name="effectiveTo" type="date" className={input} /></Field>
            <div className="col-span-2"><Field label="Description"><input name="description" required className={input} /></Field></div>
            <div className="col-span-2"><Field label="Legal reference (notification / entry)"><input name="legalRef" className={input} /></Field></div>
            <div className="col-span-2"><button className={btn}>Save draft</button></div>
          </form>
        </Card>
      </div>

      <Card title={`Rules (${rules.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr><th className="py-1">Category</th><th>v</th><th>Rate</th><th>Tariff band</th><th>Effective</th><th>Status</th><th /></tr>
            </thead>
            <tbody className="divide-y">
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">{r.category}<span className="block text-xs text-slate-500">{r.description}{r.sacCode ? ` · SAC ${r.sacCode}` : ""}</span></td>
                  <td>{r.version}</td>
                  <td>{r.treatment === "TAXABLE" ? `${r.rateBp / 100}%${r.cessBp ? ` + ${r.cessBp / 100}% cess` : ""}` : r.treatment.replace("_", " ").toLowerCase()}</td>
                  <td className="text-xs">{r.tariffMinMinor !== null || r.tariffMaxMinor !== null ? `${r.tariffMinMinor !== null ? formatInr(r.tariffMinMinor) : "0"} – ${r.tariffMaxMinor !== null ? formatInr(r.tariffMaxMinor) : "∞"}` : "any"}</td>
                  <td className="text-xs">{iso(r.effectiveFrom)} → {iso(r.effectiveTo)}</td>
                  <td>{badge(r.status)} <span className="text-xs">{r.status.toLowerCase()}</span></td>
                  <td className="space-y-1">
                    {r.status === "DRAFT" && canApprove && r.createdBy !== ctx.userId && (
                      <form action={approveRuleAction}><input type="hidden" name="ruleId" value={r.id} /><button className={btnGhost}>Approve</button></form>
                    )}
                    {r.status === "DRAFT" && r.createdBy === ctx.userId && <span className="block text-xs text-slate-500">Awaiting another approver</span>}
                    {r.status === "DRAFT" && (
                      <form action={deleteRuleAction}><input type="hidden" name="ruleId" value={r.id} /><button className={btnGhost}>Delete draft</button></form>
                    )}
                    {r.status === "APPROVED" && canApprove && (
                      <form action={retireRuleAction} className="flex gap-1"><input type="hidden" name="ruleId" value={r.id} /><input name="reason" required placeholder="Reason" className="w-28 rounded border p-1 text-xs" /><button className={btnGhost}>Retire</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
