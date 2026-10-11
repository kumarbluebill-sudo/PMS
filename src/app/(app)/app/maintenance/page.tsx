import Link from "next/link";
import { reportIssueAction } from "@/app/account-actions";
import { Badge, btn, Card, ErrorBanner, Field, fmtDate, input, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { CATEGORY_LABELS, ISSUE_CATEGORIES, ISSUE_PRIORITIES } from "@/server/domain/roomBlock";
import { getCtx } from "@/server/session";
import { listRooms } from "@/server/services/rooms";
import { listAssignableStaff, propertyToday } from "@/server/services/roomBlocks";
import { listMaintenance } from "@/server/services/stays";

const MODE_LABEL = { REPORT: "Report only", MAINTENANCE_BLOCK: "Maintenance block", OUT_OF_ORDER: "Out of order" } as const;

export default async function Maintenance({ searchParams }: PageProps<"/app/maintenance">) {
  const { error, roomId, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const [rooms, items, staff] = await Promise.all([listRooms(db, ctx), listMaintenance(db, ctx), listAssignableStaff(db, ctx)]);
  const names = new Map(staff.map((s) => [s.userId, s.name]));
  const today = await propertyToday(db, ctx);
  const canBlock = can("rooms.block");
  return (
    <>
      <PageHeader title="Maintenance and room blocks" subtitle="Blocked rooms are removed from sellable inventory for the dates covered, and come back needing cleaning." />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{ok}</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Report an issue / block a room">
          <form action={reportIssueAction} className="space-y-3">
            <Field label="Room">
              <select name="roomId" required defaultValue={typeof roomId === "string" ? roomId : undefined} className={input}>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.roomType.name}</option>)}
              </select>
            </Field>
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium text-slate-700">What should happen to the room?</legend>
              <label className="flex items-center gap-2"><input type="radio" name="mode" value="REPORT" defaultChecked /> Report only (room stays sellable)</label>
              {canBlock && <label className="flex items-center gap-2"><input type="radio" name="mode" value="MAINTENANCE_BLOCK" /> Block for maintenance (dates below)</label>}
              {canBlock && <label className="flex items-center gap-2"><input type="radio" name="mode" value="OUT_OF_ORDER" /> Mark out of order (immediately)</label>}
            </fieldset>
            <Field label="Issue category">
              <select name="category" required className={input}>
                {ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </Field>
            <Field label="Reason"><input name="title" required minLength={3} maxLength={200} className={input} placeholder="e.g. AC not cooling" /></Field>
            <Field label="Detailed description (required for Other)"><textarea name="description" rows={3} maxLength={2000} className={input} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Priority">
                <select name="priority" defaultValue="NORMAL" className={input}>
                  {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
                </select>
              </Field>
              <Field label="Assigned to">
                <select name="assignedTo" defaultValue="" className={input}>
                  <option value="">Unassigned</option>
                  {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Start date"><input type="date" name="startDate" defaultValue={today} className={input} /></Field>
              <Field label="Expected resolution"><input type="date" name="expectedResolution" className={input} /></Field>
            </div>
            {canBlock && (
              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" name="acknowledgeBookings" className="mt-0.5" />
                If bookings overlap the block, I will reassign them (otherwise the block is refused).
              </label>
            )}
            <p className="text-xs text-slate-500">Reported by you, now. {!can("rooms.approve") && canBlock && "Blocks you raise need a manager's confirmation."}</p>
            <button className={btn}>Save</button>
          </form>
        </Card>
        <div className="lg:col-span-2">
          <Card title={`Requests (${items.length})`}>
            {items.length === 0 ? <p className="text-sm text-slate-500">No requests yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-500">
                    <tr><th className="py-1">Room</th><th>Issue</th><th>Category</th><th>Priority</th><th>Type</th><th>Until</th><th>Assigned</th><th>Status</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {items.map((m) => (
                      <tr key={m.id}>
                        <td className="py-2 font-semibold">{m.room.number}</td>
                        <td><Link className="underline" href={`/app/maintenance/${m.id}`}>{m.title}</Link></td>
                        <td>{CATEGORY_LABELS[m.category as keyof typeof CATEGORY_LABELS] ?? m.category}</td>
                        <td>{m.priority.toLowerCase()}</td>
                        <td>{MODE_LABEL[m.mode as keyof typeof MODE_LABEL] ?? m.mode}{m.approvalRequired && !m.approvedBy && m.status !== "RESOLVED" ? " (unapproved)" : ""}</td>
                        <td>{m.expectedResolution ? fmtDate(m.expectedResolution) : "—"}</td>
                        <td>{m.assignedTo ? (names.get(m.assignedTo) ?? "Staff") : "—"}</td>
                        <td>{m.status === "RESOLVED" ? <Badge value="CHECKED_OUT" /> : <span className="text-xs">{m.status.replace("_", " ").toLowerCase()}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
