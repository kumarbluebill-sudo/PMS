import Link from "next/link";
import { addBuildingAction, addFloorAction, structureReorderAction, structureToggleAction } from "@/app/actions";
import { bulkAssignFloorAction, deleteFloorOrBuildingAction, renameFloorOrBuildingAction } from "@/app/property-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import ConfirmAction from "@/components/ConfirmAction";
import PropertyNav from "@/components/PropertyNav";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { getCtx } from "@/server/session";
import { bulkAssignFloor, listCategories, listRoomsAdmin } from "@/server/services/property";
import { listStructure } from "@/server/services/structure";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []);

function Move({ kind, id, label }: { kind: "building" | "floor"; id: string; label: string }) {
  return (
    <form action={structureReorderAction} className="flex gap-1">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <button name="direction" value="up" className={btnGhost} aria-label={`Move ${label} up`}>↑</button>
      <button name="direction" value="down" className={btnGhost} aria-label={`Move ${label} down`}>↓</button>
    </form>
  );
}

function Row({ kind, id, name, level, active, rooms, canManage }: { kind: "building" | "floor"; id: string; name: string; level?: number; active: boolean; rooms: number; canManage: boolean }) {
  const what = kind === "floor" ? "floor" : "building";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Move kind={kind} id={id} label={name} />
      {canManage && (
        <details className="relative">
          <summary className={`${btnGhost} cursor-pointer list-none`}>Rename</summary>
          <form action={renameFloorOrBuildingAction} className="absolute right-0 z-10 mt-1 w-64 space-y-2 rounded-lg border border-slate-300 bg-white p-3 shadow-lg">
            <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} />
            <Field label={`${kind === "floor" ? "Floor" : "Building"} name`}><input name="name" defaultValue={name} required maxLength={60} className={input} /></Field>
            {kind === "floor" && <Field label="Level number"><input name="level" type="number" min={-5} max={200} defaultValue={level} className={input} /></Field>}
            <button className={btn}>Save</button>
          </form>
        </details>
      )}
      {canManage && active && (
        <ConfirmAction
          action={structureToggleAction} fields={{ kind, id, active: "false" }} label="Deactivate" confirmLabel="Deactivate" title={`Deactivate ${name}?`}
          impact={<>It is hidden from new assignments and layouts. History is kept. {rooms > 0 ? <strong>It still has rooms; the system refuses until active rooms are moved to another {what}.</strong> : "You can reactivate it later."}</>}
        />
      )}
      {canManage && !active && (
        <form action={structureToggleAction}><input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} /><input type="hidden" name="active" value="true" /><button className={btnGhost}>Reactivate</button></form>
      )}
      {canManage && rooms === 0 && (
        <ConfirmAction
          action={deleteFloorOrBuildingAction} fields={{ kind, id }} label="Delete" confirmLabel="Delete permanently" title={`Delete ${name}?`}
          impact={`It has no rooms, so the ${what} is removed for good. This cannot be undone.`}
        />
      )}
    </div>
  );
}

export default async function Structure({ searchParams }: PageProps<"/app/structure">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const canManage = roleHasPermission(ctx.role, "rooms.manage", ctx.extra);
  const q = one(sp.q);
  const cat = one(sp.cat);
  const [buildings, rooms, types] = await Promise.all([
    listStructure(db, ctx),
    listRoomsAdmin(db, ctx, { q, roomTypeId: cat || undefined }),
    listCategories(db, ctx, { status: "active" }),
  ]);

  // Assigning many rooms to a floor: preview first, then confirm.
  const af = one(sp.af);
  const ar = many(sp.ar);
  let preview: Awaited<ReturnType<typeof bulkAssignFloor>> | null = null;
  let previewError: string | null = null;
  if (canManage && af && ar.length) {
    try { preview = await bulkAssignFloor(db, ctx, { floorId: af, roomIds: ar, dryRun: true }); } catch (e) { previewError = e instanceof AppError ? e.message : "Check the selection."; }
  }
  const floorChoices = buildings.flatMap((b) => b.floors.filter((f) => f.active).map((f) => ({ id: f.id, label: `${b.name} – ${f.label}` })));
  const byFloor = new Map<string, typeof rooms>();
  for (const r of rooms) byFloor.set(r.floorId ?? "none", [...(byFloor.get(r.floorId ?? "none") ?? []), r]);
  const tile = (r: (typeof rooms)[number]) => {
    const state = r.outOfOrder ? ["Out of order", "border-red-700 bg-red-50 text-red-950"] : r.inHouse ? ["Occupied", "border-green-700 bg-green-50 text-green-950"] : r.hasBookings ? ["Reserved", "border-blue-700 bg-blue-50 text-blue-950"] : ["Available", "border-slate-400 bg-white text-slate-900"];
    return (
      <li key={r.id}>
        <Link href={`/app/rooms/${r.id}`} title={`${r.roomType.name}, ${state[0]}`} aria-label={`Room ${r.number}, ${r.roomType.name}, ${state[0]}`} className={`block rounded border-2 px-2 py-1 text-center ${state[1]}`}>
          <span className="block text-sm font-semibold">{r.number}</span><span className="block text-[11px]">{state[0]}</span>
        </Link>
      </li>
    );
  };

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Floors and layout" }]} />
      <PageHeader title="Floors and layout" subtitle="Buildings, floors and which rooms are on each." actions={<Link href="/app/rooms/plan" className={btnGhost}>Edit floor plan</Link>} />
      <PropertyNav current="floors" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {canManage && (
            <>
              <Card title="Add building or wing">
                <form action={addBuildingAction} className="space-y-3">
                  <Field label="Name"><input name="name" required maxLength={80} placeholder="Main Building" className={input} /></Field>
                  <button className={btn}>Add building</button>
                </form>
              </Card>
              <Card title="Add floor">
                <form action={addFloorAction} className="space-y-3">
                  <Field label="Building">
                    <select name="buildingId" required className={input}>{buildings.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Floor name"><input name="label" required maxLength={80} placeholder="Floor 1" className={input} /></Field>
                    <Field label="Level number"><input name="level" type="number" min={-5} max={200} defaultValue={0} className={input} /></Field>
                  </div>
                  <button className={btn} disabled={buildings.length === 0}>Add floor</button>
                  {buildings.length === 0 && <p className="text-xs text-slate-600">Add a building first.</p>}
                </form>
              </Card>
            </>
          )}
          <Card title="Layout">
            {buildings.length === 0 ? <p className="text-sm text-slate-600">No buildings yet.</p> : (
              <ul className="space-y-4 text-sm">
                {buildings.map((b) => (
                  <li key={b.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className={b.active ? "" : "text-slate-500 line-through"}>{b.name}</strong>
                      <span className="text-xs text-slate-600">{b._count.rooms} rooms{b.active ? "" : " · inactive"}</span>
                      <Row kind="building" id={b.id} name={b.name} active={b.active} rooms={b._count.rooms + b.floors.length} canManage={canManage} />
                    </div>
                    <ul className="mt-1 divide-y border-l pl-3">
                      {b.floors.length === 0 && <li className="py-1 text-xs text-slate-600">No floors.</li>}
                      {b.floors.map((f) => (
                        <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                          <span className={f.active ? "" : "text-slate-500 line-through"}>{f.label} <span className="text-xs text-slate-600">(level {f.level}, {f._count.rooms} rooms{f.active ? "" : ", inactive"})</span></span>
                          <Row kind="floor" id={f.id} name={f.label} level={f.level} active={f.active} rooms={f._count.rooms} canManage={canManage} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          {canManage && (
            <Card title="Assign rooms to a floor">
              <form method="get" className="space-y-2">
                <Field label="Floor"><select name="af" defaultValue={af} required className={input}><option value="">Choose a floor</option>{floorChoices.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></Field>
                <fieldset className="max-h-44 overflow-y-auto rounded border border-slate-200 p-2">
                  <legend className="px-1 text-sm font-medium text-slate-700">Rooms</legend>
                  <div className="grid grid-cols-3 gap-1 text-sm sm:grid-cols-4">
                    {rooms.filter((r) => r.active).map((r) => <label key={r.id} className="flex items-center gap-1.5"><input type="checkbox" name="ar" value={r.id} defaultChecked={ar.includes(r.id)} />{r.number}</label>)}
                  </div>
                </fieldset>
                <button className={btnGhost}>Preview changes</button>
              </form>
              {previewError && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">{previewError}</p>}
              {preview && (
                <div className="mt-3 space-y-2 border-t pt-3 text-sm" role="status">
                  <table className="w-full text-left text-xs">
                    <caption className="mb-1 text-left font-medium text-slate-700">Before and after</caption>
                    <thead className="text-slate-600"><tr><th scope="col">Room</th><th scope="col">Now</th><th scope="col">After</th></tr></thead>
                    <tbody>{preview.changes.map((c) => <tr key={c.id}><td>{c.number}</td><td>{c.from ?? "No floor"}</td><td>{c.unchanged ? "no change" : c.to}</td></tr>)}</tbody>
                  </table>
                  <form action={bulkAssignFloorAction}>
                    <input type="hidden" name="floorId" value={af} />
                    {ar.map((id) => <input key={id} type="hidden" name="roomIds" value={id} />)}
                    <button className={btn}>Assign {preview.changes.filter((c) => !c.unchanged).length} room(s)</button>
                  </form>
                  <p className="text-xs text-slate-600">Rooms placed on the floor plan are removed from it and can be placed again.</p>
                </div>
              )}
            </Card>
          )}

          <Card title="Floor map">
            <form method="get" role="search" aria-label="Filter the floor map" className="mb-3 flex flex-wrap items-end gap-2">
              <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Search room</span><input name="q" defaultValue={q} placeholder="Number" className={input} /></label>
              <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Category</span><select name="cat" defaultValue={cat} className={input}><option value="">All</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
              <button className={btnGhost}>Filter</button>
            </form>
            {rooms.length === 0 ? <p className="text-sm text-slate-600">No rooms match.</p> : (
              <div className="space-y-4">
                {buildings.flatMap((b) => b.floors.map((f) => ({ b, f }))).filter(({ f }) => byFloor.has(f.id)).map(({ b, f }) => (
                  <section key={f.id}>
                    <h3 className="mb-1 text-sm font-medium">{b.name} – {f.label}</h3>
                    <ul className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">{byFloor.get(f.id)!.map(tile)}</ul>
                  </section>
                ))}
                {byFloor.has("none") && (
                  <section>
                    <h3 className="mb-1 text-sm font-medium">No floor assigned</h3>
                    <ul className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">{byFloor.get("none")!.map(tile)}</ul>
                  </section>
                )}
              </div>
            )}
            <p className="mt-3 text-xs text-slate-600">Tiles show status as text as well as colour: available, reserved, occupied or out of order.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
