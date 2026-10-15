import Link from "next/link";
import { Card, PageHeader } from "@/app/ui";
import { roleHasPermission, type Permission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

type Report = { href: string; title: string; text: string; perm: Permission };
const SECTIONS: { title: string; items: Report[] }[] = [
  {
    title: "Operations",
    items: [
      { href: "/app/operations", title: "Today's operations", text: "Arrivals, departures, in-house guests and rooms to allocate.", perm: "reservations.view" },
      { href: "/app/reservations", title: "Reservations", text: "Search and filter bookings by date, status, source and guest.", perm: "reservations.view" },
      { href: "/app/housekeeping", title: "Housekeeping status", text: "Which rooms are clean, dirty or being cleaned.", perm: "housekeeping.view" },
      { href: "/app/feedback", title: "Guest feedback", text: "Ratings and comments from guests.", perm: "feedback.view" },
    ],
  },
  {
    title: "Money",
    items: [
      { href: "/app/invoices/gst-summary", title: "GST summary", text: "Tax collected by rate and month, for your accountant.", perm: "accounting.view" },
      { href: "/app/accounting", title: "Accounting", text: "Revenue, receivables and ledger summaries.", perm: "accounting.view" },
      { href: "/app/cashier", title: "Cashier", text: "Shift collections and cash handover.", perm: "cashier.operate" },
      { href: "/app/payments", title: "Payments", text: "Every payment received, with method and reference.", perm: "billing.view" },
      { href: "/app/invoices", title: "Invoices", text: "Issued invoices, with PDF downloads.", perm: "billing.view" },
      { href: "/app/credit-notes", title: "Credit notes", text: "Corrections issued against invoices.", perm: "billing.view" },
    ],
  },
  {
    title: "Control",
    items: [
      { href: "/app/audit-logs", title: "Audit log", text: "Who changed what, and when.", perm: "audit.view" },
      { href: "/app/settings/system", title: "System and audit", text: "System checks and exports.", perm: "settings.view" },
    ],
  },
];

/** A single place to reach every report. Each link appears only if the signed-in role may open it. */
export default async function ReportsHub() {
  const ctx = await getCtx();
  const can = (p: Permission) => roleHasPermission(ctx.role, p, ctx.extra);
  const sections = SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => can(i.perm)) })).filter((s) => s.items.length > 0);
  return (
    <>
      <PageHeader title="Reports" subtitle="Operational and financial reports in one place." />
      {sections.length === 0 && <p className="text-sm text-slate-600">No reports are available to your role.</p>}
      <div className="space-y-4">
        {sections.map((s) => (
          <Card key={s.title} title={s.title}>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {s.items.map((i) => (
                <li key={i.href} className="rounded-md border border-slate-200 p-3">
                  <Link href={i.href} className="text-sm font-medium text-brand-700 hover:underline">{i.title}</Link>
                  <p className="mt-1 text-sm text-slate-600">{i.text}</p>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
