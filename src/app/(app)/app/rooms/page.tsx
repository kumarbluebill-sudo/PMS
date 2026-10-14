import { addRoomAction, roomAssignFloorAction } from "@/app/actions";
import { listStructure } from "@/server/services/structure";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRooms, listRoomTypes } from "@/server/services/rooms";

export default async function Rooms({ searchParams }: PageProps<"/app/rooms">) {
  const { error } = await searchParams;
  const ctx = await getCtx();
  const [rooms, types, buildings] = await Promise.all([listRooms(getDb(), ctx), listRoomTypes(getDb(), ctx), listStructure(getDb(), ctx)]);
  const floorOptions = buildings.flatMap((b) => b.floors.filter((f) => f.active).map((f) => ({ id: f.id, label: `${b.name} – ${f.label}` })));
  return (
    <>
      <PageHeader title="Rooms" subtitle="Add rooms one by one, or import many from a file." />
      <p className="mb-3 text-sm"><a className="text-indigo-700 underline" href="/app/rooms/import">Import rooms from CSV / Excel</a> · <a className="text-indigo-700 underline" href="/app/rooms/plan">Floor plan</a></p>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Add room">
          <form action={addRoomAction} className="space-y-3">
            <Field label="Room type">
              <select name="roomTypeId" required className={input}>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Room number"><input name="number" required className={input} /></Field>
            <Field label="Floor (optional)">
              <select name="floorId" className={input} defaultValue="">
                <option value="">No floor</option>
                {floorOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </Field>
            {floorOptions.length === 0 && <p className="text-xs text-slate-500">Define buildings and floors under Buildings &amp; floors.</p>}
            <button className={btn} disabled={types.length === 0}>Add</button>
            {types.length === 0 && <p className="text-xs text-slate-500">Create a room type first.</p>}
          </form>
        </Card>
        <Card title={`Rooms (${rooms.length})`}>
          <ul className="divide-y text-sm">
            {rooms.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{r.number} <span className="text-slate-500">{r.roomType.name}</span></span>
                <form action={roomAssignFloorAction} className="flex items-center gap-1">
                  <input type="hidden" name="roomId" value={r.id} />
                  <select name="floorId" defaultValue={r.floorId ?? ""} aria-label={`Floor for room ${r.number}`} className="max-w-40 rounded border border-slate-300 p-1 text-xs">
                    <option value="">No floor</option>
                    {floorOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                  <button className={btnGhost}>Set</button>
                </form>
                <Badge value={r.housekeeping} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
