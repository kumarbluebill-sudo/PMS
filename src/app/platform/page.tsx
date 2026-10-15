import Link from "next/link";
import { Card, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { STATUS_LABEL, type SubStatus } from "@/server/domain/subscription";
import { requirePlatform } from "@/server/platform";
import { platformOverview } from "@/server/services/platform";

const inr = (minor: number) => `Rs. ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function PlatformHome() {
  const p = await requirePlatform();
  const o = await platformOverview(getDb(), p);
  return (
    <>
      <PageHeader title="Overview" subtitle="Hotels, subscriptions and money owed to MK Solutions." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Hotels"><p className="text-2xl font-semibold">{o.total}</p></Card>
        <Card title="Monthly recurring revenue"><p className="text-2xl font-semibold">{inr(o.mrrMinor)}</p><p className="text-xs text-slate-600">Paying subscriptions, yearly fees divided by 12. Before GST.</p></Card>
        <Card title="New leads"><p className="text-2xl font-semibold"><Link className="text-brand-700 hover:underline" href="/platform/leads">{o.newLeads}</Link></p></Card>
        <Card title="Overdue"><p className="text-2xl font-semibold">{o.overdue.length}</p></Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="By status">
          <ul className="space-y-1 text-sm">
            {Object.entries(o.byStatus).map(([s, n]) => (
              <li key={s} className="flex justify-between"><Link className="hover:underline" href={`/platform/subscriptions?status=${s}`}>{STATUS_LABEL[s as SubStatus] ?? s}</Link><span>{n}</span></li>
            ))}
          </ul>
        </Card>
        <Card title="Needs attention">
          {o.overdue.length === 0 ? <p className="text-sm text-slate-600">Nothing is overdue.</p> : (
            <ul className="space-y-1 text-sm">
              {o.overdue.slice(0, 10).map((r) => <li key={r.tenantId}><Link className="text-brand-700 hover:underline" href={`/platform/subscriptions/${r.tenantId}`}>{r.hotel}</Link> {STATUS_LABEL[r.status].toLowerCase()}, owes {inr(r.openMinor)}</li>)}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
