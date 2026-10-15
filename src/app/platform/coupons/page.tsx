import { saveCouponAction } from "@/app/platform-actions";
import { btn, Card, ErrorBanner, Field, fmtDate, input, Notice, PageHeader, thead } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { requirePlatform } from "@/server/platform";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function Coupons({ searchParams }: PageProps<"/platform/coupons">) {
  const sp = await searchParams;
  const p = await requirePlatform();
  const write = p.role === "PLATFORM_SUPER_ADMIN";
  const coupons = await getDb().coupon.findMany({ orderBy: { createdAt: "desc" } });
  return (
    <>
      <PageHeader title="Coupons" subtitle="Discount codes hotels can enter on their subscription page." />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}
      <Card title="Existing coupons">
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className={thead}><tr><th className="p-2">Code</th><th>Discount</th><th>Invoices</th><th>Valid</th><th>Used</th><th>Plans</th><th>Status</th></tr></thead>
          <tbody className="divide-y">
            {coupons.map((c) => (
              <tr key={c.id}>
                <td className="p-2 font-mono">{c.code}</td>
                <td>{c.kind === "PERCENT" ? `${c.value / 100}%` : `Rs. ${c.value / 100}`}</td>
                <td>{c.months}</td>
                <td>{c.startsAt ? fmtDate(c.startsAt) : "now"} to {c.endsAt ? fmtDate(c.endsAt) : "no end"}</td>
                <td>{c.redeemed}{c.maxRedemptions != null ? ` of ${c.maxRedemptions}` : ""}</td>
                <td>{c.planCodes.length ? c.planCodes.join(", ") : "All"}</td>
                <td>{c.active ? "Active" : "Off"}</td>
              </tr>
            ))}
            {coupons.length === 0 && <tr><td className="p-3 text-slate-600" colSpan={7}>No coupons yet.</td></tr>}
          </tbody>
        </table></div>
      </Card>
      {write && (
        <div className="mt-4"><Card title="Add or change a coupon">
          <form action={saveCouponAction} className="grid gap-3 sm:grid-cols-3">
            <Field label="Code (an existing code is updated)"><input name="code" required className={`${input} uppercase`} /></Field>
            <Field label="Type"><select name="kind" className={input}><option value="PERCENT">Percentage</option><option value="AMOUNT">Fixed amount</option></select></Field>
            <Field label="Value (% or rupees)"><input name="value" required inputMode="decimal" className={input} /></Field>
            <Field label="Applies to this many invoices"><input name="months" type="number" min={1} max={36} defaultValue={1} className={input} /></Field>
            <Field label="Starts on"><input name="startsAt" type="date" className={input} /></Field>
            <Field label="Ends on"><input name="endsAt" type="date" className={input} /></Field>
            <Field label="Use limit (blank = unlimited)"><input name="maxRedemptions" type="number" min={1} className={input} /></Field>
            <Field label="Plan codes, comma separated (blank = all)"><input name="planCodes" className={input} /></Field>
            <Field label="Note"><input name="description" className={input} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked /> Active</label>
            <div className="sm:col-span-3"><button className={btn}>Save coupon</button></div>
          </form>
        </Card></div>
      )}
    </>
  );
}
