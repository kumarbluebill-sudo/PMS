import Link from "next/link";
import { notFound } from "next/navigation";
import { addRestoreTestAction, saveStatusLabelsAction, savePropertyAction } from "@/app/settings-actions";
import { btn, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { roleHasPermission, MFA_REQUIRED_ROLES, ROLES } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { keysIn, PALETTE_KEYS, type Group } from "@/server/domain/settings";
import { DISPLAY_STATUSES, STATUS_META } from "@/server/domain/roomStatus";
import { withTenant } from "@/server/db/withTenant";
import { getCtx } from "@/server/session";
import { listAuditLogs } from "@/server/services/audit";
import { getSettingsForAdmin } from "@/server/services/settings";
import { SettingsForm } from "../SettingsForm";

const GROUPS = ["general", "reservations", "rooms", "billing", "security", "notifications", "reports", "backup"] as const;
const TITLES: Record<(typeof GROUPS)[number], [string, string]> = {
  general: ["General", "Hotel details shown on documents."],
  reservations: ["Reservation settings", "Rules applied when staff take a booking."],
  rooms: ["Rooms & housekeeping", "Status labels, maintenance rules and housekeeping lists."],
  billing: ["Billing & invoices", "Invoice text, payment methods and limits."],
  security: ["Users & security", "Sign-in rules and who has access."],
  notifications: ["Notifications", "Email provider, templates and alerts."],
  reports: ["Reports", "Defaults used when building reports."],
  backup: ["Backup & recovery", "Your backup policy and restore-test record."],
};

export default async function SettingsGroup({ params, searchParams }: PageProps<"/app/settings/[group]">) {
  const { group } = await params;
  if (!(GROUPS as readonly string[]).includes(group)) return notFound();
  const g = group as (typeof GROUPS)[number];
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  if (g === "backup" ? !can("backup.configure") : !can("settings.view")) {
    return <><PageHeader title={TITLES[g][0]} /><p className="text-sm text-slate-600">You do not have access to these settings.</p></>;
  }
  const { values, secretsSet } = await getSettingsForAdmin(db, ctx);
  const back = `/app/settings/${g}`;
  const form = <SettingsForm keys={keysIn(g as Group)} values={values} secretsSet={secretsSet} ctx={ctx} back={back} />;

  const prop = g === "general" ? await withTenant(db, ctx.tenantId, (tx) => tx.property.findFirstOrThrow({ where: { id: ctx.propertyId! } })) : null;
  const logins = g === "security" && can("audit.view") ? (await listAuditLogs(db, ctx, { action: "auth." })).slice(0, 25) : [];
  const who = new Map(
    (await db.user.findMany({ where: { id: { in: logins.map((l) => l.actorId).filter((x): x is string => !!x) }, memberships: { some: { tenantId: ctx.tenantId } } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );

  return (
    <>
      <PageHeader title={TITLES[g][0]} subtitle={TITLES[g][1]} />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{ok}</p>}
      <div className="space-y-4">
        {g === "general" && prop && (
          <Card title="Property">
            <form action={savePropertyAction} className="grid gap-3 md:grid-cols-2">
              <Field label="Hotel name"><input name="name" defaultValue={prop.name} required disabled={!can("settings.manage")} className={input} /></Field>
              <Field label="Address"><input name="address" defaultValue={prop.address ?? ""} disabled={!can("settings.manage")} className={input} /></Field>
              <Field label="Time zone">
                <select name="timezone" defaultValue={prop.timezone} disabled={!can("settings.manage")} className={input}>
                  {Intl.supportedValuesOf("timeZone").map((z) => <option key={z}>{z}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Default check-in"><input type="time" name="checkInTime" defaultValue={prop.checkInTime} disabled={!can("settings.manage")} className={input} /></Field>
                <Field label="Default check-out"><input type="time" name="checkOutTime" defaultValue={prop.checkOutTime} disabled={!can("settings.manage")} className={input} /></Field>
              </div>
              <p className="text-xs text-slate-500 md:col-span-2">Currency: {prop.currency} (the only currency supported). Legal name, GSTIN and invoice prefix are under GST &amp; tax.</p>
              {can("settings.manage") && <div className="md:col-span-2"><button className={btn}>Save property</button></div>}
            </form>
          </Card>
        )}
        {g === "rooms" && (
          <Card title="Room status labels and colours">
            <p className="mb-3 text-xs text-slate-500">You can rename a status and pick another colour. The status itself, and how it is worked out, never changes. Every status always shows an icon and its text.</p>
            <form action={saveStatusLabelsAction} className="space-y-2">
              {DISPLAY_STATUSES.map((s) => {
                const o = values["rooms.statusLabels"][s];
                return (
                  <div key={s} className="grid grid-cols-[8rem_1fr_9rem] items-end gap-2 text-sm">
                    <span className="pb-2 text-slate-600">{STATUS_META[s].icon} {STATUS_META[s].label}</span>
                    <Field label="Label"><input name={`label_${s}`} defaultValue={o?.label ?? ""} placeholder={STATUS_META[s].label} maxLength={30} disabled={!can("settings.manage")} className={input} /></Field>
                    <Field label="Colour">
                      <select name={`color_${s}`} defaultValue={o?.color ?? ""} disabled={!can("settings.manage")} className={input}>
                        <option value="">Default</option>
                        {PALETTE_KEYS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </Field>
                  </div>
                );
              })}
              {can("settings.manage") && <button className={btn}>Save labels</button>}
            </form>
          </Card>
        )}
        <Card title={g === "general" ? "Contact and policies" : "Settings"}>{form}</Card>

        {g === "security" && (
          <>
            <Card title="Who must use two-factor sign-in">
              <p className="text-sm text-slate-600">These roles are required to set up an authenticator app before they can use the system: {MFA_REQUIRED_ROLES.map((r) => r.replaceAll("_", " ").toLowerCase()).join(", ")}. Each person manages their own on the <Link className="underline" href="/security">security page</Link>; an owner can reset a colleague&apos;s.</p>
              <p className="mt-2 text-sm"><Link className="underline" href="/app/users">Manage users, roles and property access</Link> ({ROLES.length} roles available). Nobody can grant themselves extra permissions, and the last owner cannot be removed.</p>
            </Card>
            <Card title="Actions that need a second person">
              <ul className="list-inside list-disc text-sm text-slate-700">
                <li>Approving a GST tax rule (the person who drafts it cannot approve it).</li>
                <li>Approving a room block raised by someone without approval authority.</li>
                <li>Closing a cash shift with a variance (approved by someone else).</li>
                <li>Refunds above the limit, company credit, balance waivers and moving charges between folios need a manager.</li>
              </ul>
            </Card>
            {can("audit.view") && (
              <Card title="Recent sign-ins">
                {logins.length === 0 ? <p className="text-sm text-slate-500">No sign-in events recorded yet.</p> : (
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-slate-500"><tr><th className="py-1">When (UTC)</th><th>Who</th><th>Result</th></tr></thead>
                    <tbody className="divide-y">
                      {logins.map((l) => (
                        <tr key={l.id}>
                          <td className="py-1 whitespace-nowrap">{fmtDate(l.at)} {l.at.toISOString().slice(11, 16)}</td>
                          <td>{who.get(l.actorId ?? "") ?? "Unknown"}</td>
                          <td>{l.action === "auth.login" ? "Signed in" : `Failed${l.reason ? ` (${l.reason})` : ""}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )}
          </>
        )}
        {g === "notifications" && (
          <Card title="Status">
            <p className="text-sm text-slate-700">
              {values["notifications.provider"] === "NONE" || !secretsSet.has("notifications.apiKey")
                ? "No email provider is connected, so nothing is sent. Reset, invitation and verification emails are only queued."
                : "A provider and key are saved, but sending through it is not built yet, so emails are still only queued."}
            </p>
          </Card>
        )}
        {g === "reports" && (
          <Card title="How reports are grouped">
            <p className="text-sm text-slate-700">Dates are grouped in the property&apos;s time zone (set under General). Exporting needs the &quot;reports.export&quot; permission. Scheduled reports are not available yet.</p>
          </Card>
        )}
        {g === "backup" && (
          <>
            <Card title="Backup status">
              <p className="text-sm text-slate-700">Backups are taken by your database host, not by this application, and this application does not yet monitor them. <strong>Last successful backup: not monitored.</strong> Check your database provider&apos;s dashboard, and keep a record of restore tests below. Ordinary staff cannot see or change this page. See the backup and recovery guide in the project docs.</p>
            </Card>
            <Card title="Record a restore test">
              <form action={addRestoreTestAction} className="grid gap-3 md:grid-cols-4">
                <Field label="Date"><input type="date" name="date" required className={input} /></Field>
                <Field label="Result"><select name="result" className={input}><option value="PASSED">Passed</option><option value="FAILED">Failed</option></select></Field>
                <div className="md:col-span-2"><Field label="Notes"><input name="notes" maxLength={300} className={input} /></Field></div>
                <div><button className={btn}>Add</button></div>
              </form>
              <ul className="mt-3 divide-y text-sm">
                {[...values["backup.restoreTests"]].reverse().map((t, i) => <li key={`${t.date}-${i}`} className="py-1.5">{t.date} · <strong>{t.result.toLowerCase()}</strong> {t.notes && <span className="text-slate-600">— {t.notes}</span>}</li>)}
                {values["backup.restoreTests"].length === 0 && <li className="py-1.5 text-slate-500">No restore tests recorded.</li>}
              </ul>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
