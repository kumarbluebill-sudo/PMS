import Link from "next/link";
import { alertStateAction } from "@/app/frontoffice-actions";
import { markNotificationsReadAction } from "@/app/notification-actions";
import { listNotifications } from "@/server/services/notifications";
import { btnGhost, Card, EmptyState, ErrorBanner, input, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import type { Alert, Severity } from "@/server/domain/kpi";
import { isManagerView, listAlerts, staffActivity } from "@/server/services/alerts";
import { getCtx } from "@/server/session";

const LABEL: Record<Severity, string> = { CRITICAL: "Critical", WARNING: "Warning", INFO: "Information" };
const STYLE: Record<Severity, string> = {
  CRITICAL: "border-red-300 bg-red-50 text-red-900",
  WARNING: "border-amber-300 bg-amber-50 text-amber-900",
  INFO: "border-brand-200 bg-brand-50 text-brand-900",
};
const ICON: Record<Severity, string> = { CRITICAL: "⛔", WARNING: "⚠", INFO: "ℹ" };

function AlertRow({ a, canAct }: { a: Alert; canAct: boolean }) {
  return (
    <li className={`rounded-lg border p-3 ${STYLE[a.severity]}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium"><span aria-hidden>{ICON[a.severity]} </span><span className="sr-only">{LABEL[a.severity]}: </span>{a.title}</p>
          <p className="text-sm">{a.detail}</p>
          {a.ack && <p className="mt-1 text-xs">{a.ack.status === "RESOLVED" ? "Resolved" : "Acknowledged"} by {a.ack.by}{a.ack.note ? `: ${a.ack.note}` : ""}</p>}
        </div>
        <div className="flex flex-wrap items-start gap-1.5">
          <Link href={a.href} className={btnGhost}>Open</Link>
          {canAct && (
            <>
              {!a.ack && (
                <form action={alertStateAction}><input type="hidden" name="key" value={a.key} /><input type="hidden" name="status" value="ACKNOWLEDGED" /><button className={btnGhost}>Acknowledge</button></form>
              )}
              {a.ack?.status !== "RESOLVED" && (
                <details className="rounded-md border border-slate-300 bg-white text-slate-800">
                  <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium">Resolve</summary>
                  <form action={alertStateAction} className="space-y-2 p-2">
                    <input type="hidden" name="key" value={a.key} /><input type="hidden" name="status" value="RESOLVED" />
                    <input name="note" required maxLength={300} placeholder="How was it resolved?" aria-label="Resolution note" className={input} />
                    <button className={btnGhost}>Mark resolved</button>
                  </form>
                </details>
              )}
              {a.ack && <form action={alertStateAction}><input type="hidden" name="key" value={a.key} /><input type="hidden" name="status" value="OPEN" /><button className={btnGhost}>Reopen</button></form>}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export default async function AlertsPage({ searchParams }: PageProps<"/app/alerts">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const showResolved = sp.resolved === "1";
  const [alerts, notes] = await Promise.all([listAlerts(getDb(), ctx, { includeResolved: showResolved }), listNotifications(getDb(), ctx, { limit: 20 })]);
  const unread = notes.filter((n) => !n.read);
  const canAct = roleHasPermission(ctx.role, "reservations.modify", ctx.extra);
  const manager = isManagerView(ctx);
  const activity = manager ? await staffActivity(getDb(), ctx) : [];
  const groups = (["CRITICAL", "WARNING", "INFO"] as const).map((s) => ({ s, rows: alerts.filter((a) => a.severity === s) }));
  return (
    <>
      <Breadcrumbs items={[{ label: "Front desk" }, { label: "Alerts" }]} />
      <PageHeader title="Alerts and tasks" subtitle="Worked out from live data. Acknowledging or resolving is recorded in the audit log." actions={<Link className={btnGhost} href={showResolved ? "/app/alerts" : "/app/alerts?resolved=1"}>{showResolved ? "Hide resolved" : "Show resolved"}</Link>} />
      <ErrorBanner message={typeof sp.error === "string" ? sp.error : undefined} />
      {typeof sp.ok === "string" && <Notice tone="success">{sp.ok}</Notice>}
      {notes.length > 0 && (
        <section aria-label="Notifications" className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Notifications <span className="font-normal text-slate-700">({unread.length} unread)</span></h2>
            {unread.length > 0 && <form action={markNotificationsReadAction}><button className={btnGhost}>Mark all as read</button></form>}
          </div>
          <ul className="space-y-1.5">
            {notes.map((n) => (
              <li key={n.id} className={`rounded-lg border p-2.5 text-sm ${n.read ? "border-slate-200 bg-white text-slate-700" : "border-brand-300 bg-brand-50 text-slate-900"}`}>
                <p className="font-medium">{n.read ? "" : <span className="mr-1 rounded bg-brand-700 px-1 text-[11px] text-white">New</span>}{n.title}</p>
                {n.body && <p className="text-xs">{n.body}</p>}
                <p className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-slate-700">{n.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC{n.href && <Link className="underline" href={n.href}>Open</Link>}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {alerts.length === 0 && <EmptyState title="No alerts right now">Overdue checkouts, rooms without allocation, unpaid balances and other issues appear here.</EmptyState>}
      <div className="space-y-5">
        {groups.filter((g) => g.rows.length > 0).map((g) => (
          <section key={g.s} aria-label={LABEL[g.s]}>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">{LABEL[g.s]} <span className="font-normal text-slate-500">({g.rows.length})</span></h2>
            <ul className="space-y-2">{g.rows.map((a) => <AlertRow key={a.key} a={a} canAct={canAct} />)}</ul>
          </section>
        ))}
        {manager && (
          <Card title="Staff activity, last 24 hours">
            {activity.length === 0 ? <p className="text-sm text-slate-600">No recorded actions.</p> : (
              <ul className="divide-y text-sm">{activity.map((a) => <li key={a.name} className="flex justify-between py-1"><span>{a.name}</span><span className="tabular-nums text-slate-600">{a.actions} actions</span></li>)}</ul>
            )}
            <p className="mt-2 text-xs"><Link className="underline" href="/app/audit-logs">Open the full audit log</Link></p>
          </Card>
        )}
      </div>
    </>
  );
}
