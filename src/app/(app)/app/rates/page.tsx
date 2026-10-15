import Link from "next/link";
import { btn, btnGhost, Card, EmptyState, ErrorBanner, input, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import PropertyNav from "@/components/PropertyNav";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { MEAL_LABELS, type MEAL_PLANS } from "@/server/domain/rates";
import { getCtx } from "@/server/session";
import { listRatePlans, previewRates } from "@/server/services/property";
import { propertyToday } from "@/server/services/roomBlocks";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function RatePlans({ searchParams }: PageProps<"/app/rates">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const canManage = roleHasPermission(ctx.role, "rates.manage", ctx.extra);
  const q = one(sp.q);
  const status = (["active", "archived", "all"] as const).find((s) => s === one(sp.status)) ?? "active";
  const roomTypeId = one(sp.roomTypeId);
  const today = await propertyToday(db, ctx);
  const from = DAY_RE.test(one(sp.from)) ? one(sp.from) : today;
  const days = [7, 14, 21].includes(Number(one(sp.days))) ? Number(one(sp.days)) : 14;
  const stay = Math.min(30, Math.max(1, Number(one(sp.stay)) || 1));
  const adults = Number(one(sp.adults)) === 1 ? 1 : 2;
  const [{ plans, types }, preview] = await Promise.all([
    listRatePlans(db, ctx, { q, status, roomTypeId: roomTypeId || undefined }),
    previewRates(db, ctx, { from, days, stayNights: stay, adults }),
  ]);
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" });

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Rate plans" }]} />
      <PageHeader
        title="Rate plans"
        subtitle="Prices are before GST. Where plans overlap, the highest priority wins, then the narrower date range, then the newer plan. With no plan, the category's default rate applies."
        actions={canManage ? <Link href="/app/rates/new" className={btn}>Add rate plan</Link> : undefined}
      />
      <PropertyNav current="rates" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <form method="get" role="search" aria-label="Filter rate plans" className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3">
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Search plans</span><input name="q" defaultValue={q} placeholder="Name or code" className={input} /></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Category</span>
          <select name="roomTypeId" defaultValue={roomTypeId} className={input}><option value="">All</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Show</span>
          <select name="status" defaultValue={status} className={input}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label>
        <input type="hidden" name="from" value={from} /><input type="hidden" name="days" value={days} />
        <button className={btn}>Apply</button>
        {(q || roomTypeId || status !== "active") && <Link href="/app/rates" className={btnGhost}>Clear</Link>}
      </form>

      <Card title={`Plans (${plans.length})`}>
        {plans.length === 0 ? (
          <EmptyState title={q || roomTypeId || status !== "active" ? "No plans match" : "No rate plans yet"}>
            {q || roomTypeId || status !== "active" ? "Clear the filters to see all." : "Every booking uses the category's default rate until you add a plan."}
          </EmptyState>
        ) : (
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Rate plans table, scrolls sideways">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead className="text-xs text-slate-600">
                <tr><th scope="col" className="py-1 pr-2">Plan</th><th scope="col" className="pr-2">Categories</th><th scope="col" className="pr-2">Valid</th><th scope="col" className="pr-2">Priority</th><th scope="col" className="pr-2">Meals and policy</th><th scope="col" className="pr-2">Status</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody className="divide-y">
                {plans.map((p) => (
                  <tr key={p.id} className="align-top">
                    <td className="py-2 pr-2"><Link className="font-medium underline" href={`/app/rates/${p.id}`}>{p.name}</Link><span className="block font-mono text-xs text-slate-600">{p.code}</span></td>
                    <td className="pr-2">{p.rates.map((r) => <span key={r.id} className="block">{typeName.get(r.roomTypeId) ?? "Category"} <span className="tabular-nums text-slate-600">{inr(r.weekdayRateMinor)}{r.weekendRateMinor !== null ? ` / ${inr(r.weekendRateMinor)}` : ""}</span></span>)}</td>
                    <td className="whitespace-nowrap pr-2">{p.validFrom || p.validTo ? `${p.validFrom?.toISOString().slice(0, 10) ?? "start"} to ${p.validTo?.toISOString().slice(0, 10) ?? "no end"}` : "Always"}</td>
                    <td className="pr-2 tabular-nums">{p.priority}</td>
                    <td className="pr-2">{MEAL_LABELS[p.mealPlan as (typeof MEAL_PLANS)[number]] ?? p.mealPlan}<span className="block text-xs text-slate-600">{p.refundable ? "Refundable" : "Non-refundable"}{p.minStay ? ` · min ${p.minStay} nights` : ""}{p.maxStay ? ` · max ${p.maxStay}` : ""}</span></td>
                    <td className="pr-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.active ? "bg-emerald-50 text-emerald-900" : "bg-slate-200 text-slate-800"}`}>{p.active ? "Active" : "Archived"}</span></td>
                    <td><div className="flex gap-1.5"><Link href={`/app/rates/${p.id}`} className={btnGhost}>{canManage ? "Edit" : "View"}</Link></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4">
        <Card title="Effective rate preview">
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="q" value={q} /><input type="hidden" name="status" value={status} /><input type="hidden" name="roomTypeId" value={roomTypeId} />
            <label className="space-y-1"><span className="text-xs font-medium text-slate-700">From date</span><input type="date" name="from" defaultValue={from} className={input} /></label>
            <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Days shown</span>
              <select name="days" defaultValue={days} className={input}><option value="7">7</option><option value="14">14</option><option value="21">21</option></select></label>
            <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Stay length (nights)</span><input type="number" name="stay" min={1} max={30} defaultValue={stay} className={`${input} w-24`} /></label>
            <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Guests</span>
              <select name="adults" defaultValue={adults} className={input}><option value="2">2 adults</option><option value="1">1 adult</option></select></label>
            <button className={btnGhost}>Update preview</button>
          </form>
          {preview.rows.length === 0 ? <p className="text-sm text-slate-600">Add a room category to preview rates.</p> : (
            <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Effective rates by date, scrolls sideways">
              <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
                <caption className="mb-1 text-left text-sm text-slate-700">Price per night before GST as a booking would get it. The second line names the plan that sets the price; &ldquo;default&rdquo; means the category rate.</caption>
                <thead className="text-slate-600"><tr><th scope="col" className="sticky left-0 bg-white py-1 pr-2">Category</th>{preview.dates.map((d) => <th scope="col" key={d} className="px-1 font-medium">{fmtDay(d)}</th>)}</tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.type.id} className="border-t">
                      <th scope="row" className="sticky left-0 bg-white py-1.5 pr-2 font-medium">{r.type.name}</th>
                      {r.nights.map((n) => (
                        <td key={n.date} className={`px-1 py-1 align-top tabular-nums ${n.planId ? "bg-brand-50" : ""}`}>
                          {inr(n.rateMinor)}<span className="block max-w-24 truncate text-[11px] text-slate-600" title={n.planName ?? "default"}>{n.planName ?? "default"}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
