import Link from "next/link";
import { createTaskAction, dndAction, reportIssueAction, stayoverAction, taskActionAction } from "@/app/housekeeping-actions";
import { btn, btnGhost, Card, EmptyState, ErrorBanner, Field, input, Notice, PageHeader } from "@/app/ui";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { HK_CODES, HK_SHORT, PRIORITIES, type HkCode } from "@/server/domain/housekeeping";
import { CATEGORY_LABELS, ISSUE_CATEGORIES } from "@/server/domain/roomBlock";
import { getCtx } from "@/server/session";
import { housekeepingBoard, housekeepingStaff, type BoardFilter, type BoardRow } from "@/server/services/housekeepingTasks";
import { listRoomTypes } from "@/server/services/rooms";
import { listStructure } from "@/server/services/structure";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const STATES = ["awaiting-cleaning", "cleaning", "awaiting-inspection", "ready", "arrivals-not-ready", "overdue", "ooo", "dnd", "departed"] as const;

const CODE_STYLE: Record<HkCode, { icon: string; cls: string }> = {
  VD: { icon: "◌", cls: "border-amber-700 bg-amber-50 text-amber-950" },
  VC: { icon: "✓", cls: "border-green-700 bg-green-50 text-green-950" },
  VI: { icon: "✔✔", cls: "border-emerald-800 bg-emerald-100 text-emerald-950" },
  OD: { icon: "●", cls: "border-orange-700 bg-orange-50 text-orange-950" },
  OC: { icon: "●✓", cls: "border-sky-700 bg-sky-50 text-sky-950" },
  STAYOVER: { icon: "↻", cls: "border-violet-700 bg-violet-50 text-violet-950" },
  DND: { icon: "⊘", cls: "border-slate-700 bg-slate-100 text-slate-950" },
  OOO: { icon: "✕", cls: "border-red-700 bg-red-50 text-red-950" },
  OOS: { icon: "⚠", cls: "border-rose-700 bg-rose-50 text-rose-950" },
};

const when = (d: Date | null) => (d ? d.toISOString().slice(5, 16).replace("T", " ") : "—");

export default async function Housekeeping({ searchParams }: PageProps<"/app/housekeeping">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const canUpdate = can("housekeeping.update");
  const canManage = can("housekeeping.manage");
  const canReport = can("maintenance.report") || can("maintenance.manage");
  const f: BoardFilter = {
    q: one(sp.q), floorId: one(sp.floorId) || undefined, roomTypeId: one(sp.roomTypeId) || undefined,
    code: (HK_CODES as readonly string[]).includes(one(sp.code)) ? (one(sp.code) as HkCode) : undefined,
    assignee: one(sp.assignee) || undefined, priority: (PRIORITIES as readonly string[]).includes(one(sp.priority)) ? one(sp.priority) : undefined,
    state: (STATES as readonly string[]).includes(one(sp.state)) ? (one(sp.state) as (typeof STATES)[number]) : undefined,
  };
  const [board, types, buildings, staff] = await Promise.all([
    housekeepingBoard(db, ctx, f), listRoomTypes(db, ctx), listStructure(db, ctx), canManage ? housekeepingStaff(db, ctx) : Promise.resolve([]),
  ]);
  const floors = buildings.flatMap((b) => b.floors.map((x) => ({ id: x.id, label: `${b.name} – ${x.label}` })));
  const active = Object.entries(f).filter(([, v]) => v);
  const back = `/app/housekeeping${active.length ? `?${new URLSearchParams(active.map(([k, v]) => [k, String(v)]))}` : ""}`;
  const s = board.summary;
  const cards: { state: (typeof STATES)[number]; label: string; value: number }[] = [
    { state: "awaiting-cleaning", label: "Awaiting cleaning", value: s.awaitingCleaning },
    { state: "cleaning", label: "Being cleaned", value: s.beingCleaned },
    { state: "awaiting-inspection", label: "Awaiting inspection", value: s.awaitingInspection },
    { state: "ready", label: "Clean and ready", value: s.ready },
    { state: "arrivals-not-ready", label: "Arrivals, room not ready", value: s.arrivalsNotReady },
    { state: "departed", label: "Checked out today", value: s.departedToday },
    { state: "overdue", label: "Overdue tasks", value: s.overdue },
    { state: "ooo", label: "Out of order", value: s.outOfOrder },
    { state: "dnd", label: "Do Not Disturb", value: s.dnd },
  ];
  const hidden = (r: BoardRow) => (
    <>
      <input type="hidden" name="back" value={back} />
      {r.task && <><input type="hidden" name="taskId" value={r.task.id} /><input type="hidden" name="version" value={r.task.version} /></>}
    </>
  );
  const act = (r: BoardRow, action: string, label: string, primary = false) => (
    <form action={taskActionAction} className="inline">{hidden(r)}<input type="hidden" name="action" value={action} /><button className={primary ? `${btn} px-2.5 py-1 text-xs` : `${btnGhost} px-2.5 py-1 text-xs`}>{label}</button></form>
  );

  return (
    <>
      <PageHeader
        title="Housekeeping"
        subtitle={`${board.today} · ${board.inspectionRequired ? "A cleaned room must be inspected before it counts as ready." : "A cleaned room counts as ready; inspection is optional."}`}
        actions={<>
          {canUpdate && <Link href="/app/housekeeping?assignee=me" className={btnGhost}>My rooms</Link>}
          {canManage && <form action={stayoverAction}><input type="hidden" name="back" value={back} /><button className={btnGhost}>Generate stayover tasks</button></form>}
        </>}
      />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <ul aria-label="Housekeeping summary" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {cards.map((c) => {
          const on = f.state === c.state;
          return (
            <li key={c.state}>
              <Link href={on ? "/app/housekeeping" : `/app/housekeeping?state=${c.state}`} aria-current={on ? "true" : undefined} className={`block rounded-lg border p-2.5 transition-colors hover:border-brand-600 ${on ? "border-brand-700 bg-brand-50" : "border-slate-200 bg-white"} ${c.value > 0 && ["arrivals-not-ready", "overdue", "ooo"].includes(c.state) ? "border-l-4 border-l-red-700" : ""}`}>
                <span className="block text-xs text-slate-700">{c.label}</span>
                <span className="block text-xl font-semibold tabular-nums">{c.value}</span>
                <span className="sr-only">{on ? "Showing these rooms. Select to show all." : "Select to show only these rooms."}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <form method="get" role="search" aria-label="Filter rooms" className="mb-3 grid gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-7">
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Room number</span><input name="q" defaultValue={f.q} className={input} /></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Floor</span><select name="floorId" defaultValue={f.floorId ?? ""} className={input}><option value="">All</option>{floors.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Category</span><select name="roomTypeId" defaultValue={f.roomTypeId ?? ""} className={input}><option value="">All</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Status</span><select name="code" defaultValue={f.code ?? ""} className={input}><option value="">Any</option>{HK_CODES.map((c) => <option key={c} value={c}>{HK_SHORT[c]} · {board.labels[c]}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Assigned to</span><select name="assignee" defaultValue={f.assignee ?? ""} className={input}><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option>{staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Priority</span><select name="priority" defaultValue={f.priority ?? ""} className={input}><option value="">Any</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}</select></label>
        <div className="flex items-end gap-2"><button className={btn}>Apply</button>{active.length > 0 && <Link href="/app/housekeeping" className={btnGhost}>Clear</Link>}</div>
      </form>

      <Card title={`Rooms (${board.rows.length} of ${s.total})`}>
        {board.rows.length === 0 ? (
          <EmptyState title="No rooms match">{active.length ? "Clear the filters to see every room." : "Add rooms under Property management."}</EmptyState>
        ) : (
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Housekeeping rooms, scrolls sideways">
            <table className="w-full min-w-[68rem] text-left text-sm">
              <thead className="text-xs text-slate-700">
                <tr>
                  <th scope="col" className="py-1 pr-2">Room</th><th scope="col" className="pr-2">Stay</th><th scope="col" className="pr-2">Status</th><th scope="col" className="pr-2">Priority</th>
                  <th scope="col" className="pr-2">Assigned</th><th scope="col" className="pr-2">Created</th><th scope="col" className="pr-2">Updated</th><th scope="col" className="pr-2">Maintenance</th><th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {board.rows.map((r) => {
                  const cs = CODE_STYLE[r.code];
                  const t = r.task;
                  return (
                    <tr key={r.roomId} className="align-top">
                      <td className="py-2 pr-2">
                        <span className="font-semibold">{r.number}</span>
                        <span className="block text-xs text-slate-700">{[r.floor, r.category].filter(Boolean).join(" · ")}</span>
                        {r.arrivalToday && <span className={`mt-0.5 inline-block rounded border px-1 text-[11px] font-medium ${r.ready ? "border-green-700 text-green-900" : "border-red-700 text-red-900"}`}>Arrival today: {r.ready ? "room ready" : "room not ready"}</span>}
                      </td>
                      <td className="pr-2">
                        <span className="block">{r.checkout}</span>
                        {r.reservationRef && <Link className="font-mono text-xs underline" href={`/app/reservations/${r.reservationId}`}>{r.reservationRef}</Link>}
                        {r.guest && <span className="block text-xs text-slate-700">{r.guest}</span>}
                      </td>
                      <td className="pr-2">
                        <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${cs.cls}`} title={board.labels[r.code]}><span aria-hidden>{cs.icon}</span>{HK_SHORT[r.code]}<span className="font-normal"> · {board.labels[r.code]}</span></span>
                        {t && <span className="mt-0.5 block text-xs text-slate-700">{t.kind.toLowerCase()} · {t.status.replace(/_/g, " ").toLowerCase()}{t.inspectionResult === "FAILED" ? " (failed inspection)" : ""}</span>}
                        {r.overdue && <span className="mt-0.5 inline-block rounded border border-red-700 px-1 text-[11px] font-medium text-red-900">Overdue</span>}
                      </td>
                      <td className="pr-2">{t ? t.priority.toLowerCase() : "—"}</td>
                      <td className="pr-2">{t?.assignedTo ?? (t ? <span className="text-slate-700">Unassigned</span> : "—")}</td>
                      <td className="whitespace-nowrap pr-2 text-xs">{when(t?.createdAt ?? null)}</td>
                      <td className="whitespace-nowrap pr-2 text-xs">{when(r.lastUpdate)}</td>
                      <td className="pr-2 text-xs">{r.maintenance.open > 0 ? <span className={r.maintenance.blocking ? "font-medium text-red-900" : ""}>{r.maintenance.blocking ? "Blocking: " : ""}{r.maintenance.title}{r.maintenance.open > 1 ? ` (+${r.maintenance.open - 1})` : ""}</span> : "—"}</td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1">
                          {canUpdate && t?.status === "PENDING" && act(r, "START", "Start cleaning", true)}
                          {canUpdate && (t?.status === "PENDING" || t?.status === "IN_PROGRESS") && act(r, "COMPLETE", board.inspectionRequired ? "Done, request inspection" : "Mark clean", t.status === "IN_PROGRESS")}
                          {canManage && t?.status === "AWAITING_INSPECTION" && act(r, "INSPECT_PASS", "Pass inspection", true)}
                          {canManage && t?.status === "AWAITING_INSPECTION" && act(r, "INSPECT_FAIL", "Fail inspection")}
                          {canManage && t && ["DONE", "INSPECTED", "AWAITING_INSPECTION"].includes(t.status) && act(r, "REOPEN", "Reopen")}
                          {canManage && !t && r.code !== "OOO" && (
                            <form action={createTaskAction} className="inline"><input type="hidden" name="back" value={back} /><input type="hidden" name="roomId" value={r.roomId} /><button className={`${btnGhost} px-2.5 py-1 text-xs`}>Create task</button></form>
                          )}
                          <details className="relative">
                            <summary className={`${btnGhost} cursor-pointer list-none px-2.5 py-1 text-xs`}>More<span className="sr-only"> actions for room {r.number}</span></summary>
                            <div className="absolute right-0 z-10 mt-1 w-72 space-y-3 rounded-lg border border-slate-300 bg-white p-3 text-sm shadow-lg">
                              {canUpdate && t && (
                                <form action={taskActionAction} className="space-y-1.5">{hidden(r)}<input type="hidden" name="action" value="NOTE" />
                                  <Field label="Add a note"><input name="note" maxLength={300} required className={input} /></Field><button className={`${btnGhost} px-2.5 py-1 text-xs`}>Save note</button>
                                  {t.note && <p className="whitespace-pre-wrap text-xs text-slate-700">{t.note}</p>}
                                </form>
                              )}
                              {canManage && t && (
                                <form action={taskActionAction} className="space-y-1.5">{hidden(r)}<input type="hidden" name="action" value="ASSIGN" />
                                  <Field label="Assign to"><select name="assignedTo" defaultValue={t.assignedToId ?? ""} className={input}><option value="">Unassigned</option>{staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
                                  <button className={`${btnGhost} px-2.5 py-1 text-xs`}>Save assignment</button>
                                </form>
                              )}
                              {canManage && t && (
                                <form action={taskActionAction} className="space-y-1.5">{hidden(r)}<input type="hidden" name="action" value="PRIORITY" />
                                  <Field label="Priority"><select name="priority" defaultValue={t.priority} className={input}>{PRIORITIES.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}</select></Field>
                                  <button className={`${btnGhost} px-2.5 py-1 text-xs`}>Save priority</button>
                                </form>
                              )}
                              {canUpdate && (
                                <form action={dndAction} className="space-y-1.5"><input type="hidden" name="back" value={back} /><input type="hidden" name="roomId" value={r.roomId} /><input type="hidden" name="dnd" value={String(!r.dnd)} />
                                  <button className={`${btnGhost} px-2.5 py-1 text-xs`}>{r.dnd ? "Clear Do Not Disturb" : "Mark Do Not Disturb"}</button></form>
                              )}
                              {canReport && (
                                <form action={reportIssueAction} className="space-y-1.5"><input type="hidden" name="back" value={back} /><input type="hidden" name="roomId" value={r.roomId} />
                                  <Field label="Report a maintenance issue"><input name="title" required minLength={3} maxLength={200} placeholder="What is wrong?" className={input} /></Field>
                                  <select name="category" aria-label="Issue category" className={input}>{ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}</select>
                                  <button className={`${btnGhost} px-2.5 py-1 text-xs`}>Report issue</button>
                                </form>
                              )}
                            </div>
                          </details>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-2 text-xs text-slate-700">Housekeeping status, whether a guest is in the room, and maintenance are separate. A cleaned occupied room becomes Occupied – Clean; it is never offered for sale. An out-of-order room stays out of order until a supervisor clears it.</p>
    </>
  );
}
