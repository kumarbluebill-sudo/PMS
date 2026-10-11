import Link from "next/link";
import { approveBlockAction, resolveIssueAction, updateIssueAction } from "@/app/account-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { CATEGORY_LABELS } from "@/server/domain/roomBlock";
import { getCtx } from "@/server/session";
import { getIssue, listAssignableStaff } from "@/server/services/roomBlocks";

const STATE_LABEL: Record<string, string> = {
  OPERATIONAL: "Operational", OUT_OF_ORDER: "Out of order", MAINTENANCE: "Maintenance", NEEDS_CLEANING: "Needs cleaning", STILL_BLOCKED: "Still blocked",
  DIRTY: "Dirty", CLEANING: "Cleaning", CLEAN: "Clean", INSPECTED: "Inspected", MAINTENANCE_BLOCK: "Maintenance",
};
const label = (s: string | null) => (s ? (STATE_LABEL[s] ?? s) : "—");
const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function IssueDetail({ params, searchParams }: PageProps<"/app/maintenance/[id]">) {
  const { id } = await params;
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const { req: m, timeline, names } = await getIssue(db, ctx, id);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const staff = can("maintenance.manage") ? await listAssignableStaff(db, ctx) : [];
  const open = m.status !== "RESOLVED";
  const who = (u: string | null) => (u ? (names.get(u) ?? "Staff member") : "—");
  const needsApproval = m.approvalRequired && !m.approvedBy && open;
  return (
    <>
      <PageHeader title={`Room ${m.room.number}: ${m.title}`} subtitle={`${CATEGORY_LABELS[m.category as keyof typeof CATEGORY_LABELS] ?? m.category} · ${m.priority.toLowerCase()} priority`} />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{ok}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Record">
          <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Room</dt><dd>{m.room.number} ({m.room.roomType.name})</dd>
            <dt className="text-slate-500">Type</dt><dd>{m.mode === "OUT_OF_ORDER" ? "Out of order" : m.mode === "MAINTENANCE_BLOCK" ? "Maintenance block" : "Report only"}</dd>
            <dt className="text-slate-500">Status</dt><dd>{m.status.replace("_", " ").toLowerCase()}</dd>
            <dt className="text-slate-500">Reported</dt><dd>{stamp(m.reportedAt)} by {who(m.reportedBy)}</dd>
            <dt className="text-slate-500">Start</dt><dd>{m.startDate ? fmtDate(m.startDate) : "—"}</dd>
            <dt className="text-slate-500">Expected resolution</dt><dd>{m.expectedResolution ? fmtDate(m.expectedResolution) : "Not set"}</dd>
            <dt className="text-slate-500">Assigned to</dt><dd>{who(m.assignedTo)}</dd>
            {m.description && (<><dt className="text-slate-500">Description</dt><dd className="whitespace-pre-wrap">{m.description}</dd></>)}
            {m.approvalRequired && (<><dt className="text-slate-500">Approval</dt><dd>{m.approvedBy ? `Approved by ${who(m.approvedBy)}` : "Awaiting a manager's approval"}</dd></>)}
            {m.status === "RESOLVED" && (
              <>
                <dt className="text-slate-500">Resolved</dt><dd>{m.resolvedAt ? stamp(m.resolvedAt) : "—"} by {who(m.resolvedBy)}</dd>
                <dt className="text-slate-500">Resolution</dt><dd className="whitespace-pre-wrap">{m.resolutionNote}</dd>
              </>
            )}
          </dl>
          <p className="mt-3 text-xs text-slate-500">Photo attachments are not available yet (needs file storage).</p>
        </Card>

        <Card title="Room status history">
          {timeline.length === 0 ? <p className="text-sm text-slate-500">No changes recorded.</p> : (
            <ol className="space-y-2 text-sm">
              {timeline.map((t) => (
                <li key={t.id} className={t.maintenanceId === m.id ? "font-medium" : ""}>
                  <span className="text-xs text-slate-500">{stamp(t.changedAt)} · {who(t.changedBy)}</span><br />
                  {label(t.fromState)} → {label(t.toState)}{t.reason ? <span className="text-slate-600"> — {t.reason}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </Card>

        {needsApproval && can("rooms.approve") && m.reportedBy !== ctx.userId && (
          <Card title="Approve block">
            <p className="mb-2 text-sm text-slate-600">This block took effect immediately and needs a manager&apos;s confirmation.</p>
            <form action={approveBlockAction}><input type="hidden" name="id" value={m.id} /><button className={btn}>Approve block</button></form>
          </Card>
        )}

        {open && can("maintenance.manage") && (
          <Card title="Progress and assignment">
            <form action={updateIssueAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={m.id} />
              <Field label="Status">
                <select name="status" defaultValue={m.status} className={input}>
                  <option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option>
                </select>
              </Field>
              <Field label="Assigned to">
                <select name="assignedTo" defaultValue={m.assignedTo ?? ""} className={input}>
                  <option value="">Unassigned</option>
                  {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
                </select>
              </Field>
              <button className={btnGhost}>Update</button>
            </form>
          </Card>
        )}

        {open && can("rooms.resolve") && (
          <Card title={m.blocksRoom ? "Resolve and return room to service" : "Resolve"}>
            <form action={resolveIssueAction} className="space-y-3">
              <input type="hidden" name="id" value={m.id} />
              <Field label="What was done?"><textarea name="resolutionNote" required minLength={5} rows={3} className={input} /></Field>
              {m.blocksRoom && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="confirmReady" className="mt-0.5" required />
                  I have checked the room and it is ready. (It will be marked for cleaning before it can be sold.)
                </label>
              )}
              <button className={btn}>Resolve</button>
            </form>
          </Card>
        )}
      </div>
      <p className="mt-4"><Link className="text-sm underline" href="/app/maintenance">Back to requests</Link></p>
    </>
  );
}
