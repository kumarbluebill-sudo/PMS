import Link from "next/link";
import { btn, Card, fmtDate, input, PageHeader, thead } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { STATUS_LABEL } from "@/server/domain/subscription";
import { requirePlatform } from "@/server/platform";
import { listSubscriptions } from "@/server/services/platform";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const inr = (minor: number) => `Rs. ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function Subscriptions({ searchParams }: PageProps<"/platform/subscriptions">) {
  const sp = await searchParams;
  const p = await requirePlatform();
  const rows = await listSubscriptions(getDb(), p, { status: one(sp.status) || undefined, q: one(sp.q) || undefined });
  return (
    <>
      <PageHeader title="Subscriptions" subtitle="Every hotel and where its subscription stands." />
      <form className="mb-3 flex flex-wrap items-end gap-2" role="search">
        <label className="text-sm">Hotel or plan<input name="q" defaultValue={one(sp.q)} className={`${input} mt-1`} /></label>
        <label className="text-sm">Status
          <select name="status" defaultValue={one(sp.status)} className={`${input} mt-1`}>
            <option value="">All</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <button className={btn}>Filter</button>
      </form>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={thead}><tr><th className="p-2">Hotel</th><th>Plan</th><th>Status</th><th>Ends</th><th className="text-right">Price</th><th className="text-right">Owed</th></tr></thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.tenantId}>
                  <td className="p-2"><Link className="font-medium text-brand-700 hover:underline" href={`/platform/subscriptions/${r.tenantId}`}>{r.hotel}</Link></td>
                  <td>{r.planName}, {r.interval === "ANNUAL" ? "yearly" : "monthly"}</td>
                  <td>{STATUS_LABEL[r.status]}{r.cancelAtPeriodEnd ? " (cancelling)" : ""}</td>
                  <td>{r.status === "TRIAL" ? (r.trialEndsAt ? fmtDate(r.trialEndsAt) : "") : r.periodEnd ? fmtDate(r.periodEnd) : "No end date"}</td>
                  <td className="text-right">{r.priceMinor === 0 ? "Free" : inr(r.priceMinor)}</td>
                  <td className="text-right">{r.openMinor ? inr(r.openMinor) : ""}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td className="p-3 text-slate-600" colSpan={6}>No hotels match.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
