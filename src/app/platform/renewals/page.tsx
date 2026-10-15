import Link from "next/link";
import { Card, fmtDate, PageHeader, thead } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { STATUS_LABEL } from "@/server/domain/subscription";
import { requirePlatform } from "@/server/platform";
import { listSubscriptions } from "@/server/services/platform";

const inr = (minor: number) => `Rs. ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function Renewals() {
  const p = await requirePlatform();
  const rows = await listSubscriptions(getDb(), p);
  const soon = rows.filter((r) => r.periodEnd && ["ACTIVE", "PAYMENT_DUE"].includes(r.status) && r.priceMinor > 0).sort((a, b) => a.periodEnd!.getTime() - b.periodEnd!.getTime());
  const late = rows.filter((r) => ["PAST_DUE", "SUSPENDED"].includes(r.status));
  const trials = rows.filter((r) => r.status === "TRIAL").sort((a, b) => (a.trialEndsAt?.getTime() ?? 0) - (b.trialEndsAt?.getTime() ?? 0));
  const table = (list: typeof rows, endKey: "periodEnd" | "trialEndsAt") => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className={thead}><tr><th className="p-2">Hotel</th><th>Plan</th><th>Status</th><th>Date</th><th className="text-right">Owed</th></tr></thead>
        <tbody className="divide-y">
          {list.map((r) => (
            <tr key={r.tenantId}>
              <td className="p-2"><Link className="text-brand-700 hover:underline" href={`/platform/subscriptions/${r.tenantId}`}>{r.hotel}</Link></td>
              <td>{r.planName}</td><td>{STATUS_LABEL[r.status]}</td>
              <td>{r[endKey] ? fmtDate(r[endKey]!) : ""}</td><td className="text-right">{r.openMinor ? inr(r.openMinor) : ""}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td className="p-3 text-slate-600" colSpan={5}>None.</td></tr>}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <PageHeader title="Renewals and overdue" subtitle="What is due, what is late, and which trials end soon." />
      <div className="space-y-4">
        <Card title="Overdue and suspended">{table(late, "periodEnd")}</Card>
        <Card title="Upcoming renewals">{table(soon, "periodEnd")}</Card>
        <Card title="Trials ending">{table(trials, "trialEndsAt")}</Card>
      </div>
    </>
  );
}
