import { addBuildingAction, addFloorAction, structureReorderAction, structureToggleAction } from "@/app/actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listStructure } from "@/server/services/structure";

function Toggle({ kind, id, active }: { kind: "building" | "floor"; id: string; active: boolean }) {
  return (
    <form action={structureToggleAction}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={String(!active)} />
      <button className={btnGhost}>{active ? "Deactivate" : "Reactivate"}</button>
    </form>
  );
}

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

export default async function Structure({ searchParams }: PageProps<"/app/structure">) {
  const { error } = await searchParams;
  const buildings = await listStructure(getDb(), await getCtx());
  return (
    <>
      <PageHeader title="Buildings & floors" />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <Card title="Add building or wing">
            <form action={addBuildingAction} className="space-y-3">
              <Field label="Name"><input name="name" required maxLength={80} placeholder="Main Building" className={input} /></Field>
              <button className={btn}>Add building</button>
            </form>
          </Card>
          <Card title="Add floor">
            <form action={addFloorAction} className="space-y-3">
              <Field label="Building">
                <select name="buildingId" required className={input}>
                  {buildings.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Floor name"><input name="label" required maxLength={80} placeholder="Floor 1" className={input} /></Field>
                <Field label="Level number"><input name="level" type="number" min={-5} max={200} defaultValue={0} className={input} /></Field>
              </div>
              <button className={btn} disabled={buildings.length === 0}>Add floor</button>
              {buildings.length === 0 && <p className="text-xs text-slate-500">Add a building first.</p>}
            </form>
          </Card>
        </div>
        <Card title="Layout">
          {buildings.length === 0 ? <p className="text-sm text-slate-500">No buildings yet.</p> : (
            <ul className="space-y-4 text-sm">
              {buildings.map((b) => (
                <li key={b.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className={b.active ? "" : "text-slate-400 line-through"}>{b.name}</strong>
                    <span className="text-xs text-slate-500">{b._count.rooms} rooms{b.active ? "" : " · inactive"}</span>
                    <span className="flex gap-1"><Move kind="building" id={b.id} label={b.name} /><Toggle kind="building" id={b.id} active={b.active} /></span>
                  </div>
                  <ul className="mt-1 divide-y border-l pl-3">
                    {b.floors.length === 0 && <li className="py-1 text-xs text-slate-500">No floors.</li>}
                    {b.floors.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                        <span className={f.active ? "" : "text-slate-400 line-through"}>{f.label} <span className="text-xs text-slate-500">(level {f.level}, {f._count.rooms} rooms{f.active ? "" : ", inactive"})</span></span>
                        <span className="flex gap-1"><Move kind="floor" id={f.id} label={f.label} /><Toggle kind="floor" id={f.id} active={f.active} /></span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
