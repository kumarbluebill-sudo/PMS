import Link from "next/link";
import { placeRoomAction } from "@/app/actions";
import { btn, btnGhost, Card, ErrorBanner, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { roleHasPermission } from "@/server/auth/permissions";
import { getFloorPlan, GRID_COLS, GRID_ROWS, listStructure } from "@/server/services/structure";

export default async function FloorPlan({ searchParams }: PageProps<"/app/rooms/plan">) {
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const ctx = await getCtx();
  const buildings = await listStructure(getDb(), ctx);
  const floors = buildings.flatMap((b) => b.floors.filter((f) => f.active).map((f) => ({ id: f.id, label: `${b.name} – ${f.label}` })));
  const floorId = typeof sp.floor === "string" && floors.some((f) => f.id === sp.floor) ? sp.floor : floors[0]?.id;
  const canEdit = roleHasPermission(ctx.role, "rooms.manage", ctx.extra);
  const plan = floorId ? await getFloorPlan(getDb(), ctx, floorId) : null;
  const at = (x: number, y: number) => plan?.rooms.find((r) => r.layoutX === x && r.layoutY === y);
  const unplaced = plan?.rooms.filter((r) => r.layoutX === null) ?? [];

  return (
    <>
      <PageHeader title="Floor plan" subtitle="Arrange room tiles on a grid. Use the controls under the grid to place or move a room." />
      <ErrorBanner message={error} />
      {floors.length === 0 ? (
        <Card><p className="text-sm text-slate-600">Define buildings and floors first, then assign rooms to them. <Link className="text-indigo-700 underline" href="/app/structure">Buildings &amp; floors</Link></p></Card>
      ) : (
        <div className="space-y-4">
          <nav aria-label="Floor" className="flex flex-wrap gap-2">
            {floors.map((f) => (
              <Link key={f.id} href={`/app/rooms/plan?floor=${f.id}`} aria-current={f.id === floorId ? "page" : undefined}
                className={`rounded border px-3 py-1 text-sm ${f.id === floorId ? "border-indigo-700 bg-indigo-50 font-medium" : "border-slate-300"}`}>{f.label}</Link>
            ))}
          </nav>
          {plan && (
            <>
              <div className="overflow-x-auto">
                <div role="grid" aria-label={`Plan of ${plan.floor.building.name} ${plan.floor.label}`} className="grid gap-1" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(4.5rem, 1fr))` }}>
                  {Array.from({ length: GRID_ROWS }).flatMap((_, y) =>
                    Array.from({ length: GRID_COLS }).map((__, x) => {
                      const r = at(x, y);
                      return r ? (
                        <div key={`${x}-${y}`} role="gridcell" className={`rounded border p-1 text-xs ${r.outOfOrder ? "border-red-400 bg-red-50" : "border-slate-300 bg-white"}`}>
                          <strong>{r.number}</strong>
                          <span className="block truncate text-slate-500">{r.roomType.name}</span>
                          <span className="block text-slate-600">{r.outOfOrder ? "Out of order" : r.housekeeping === "CLEAN" ? "Clean" : "Needs cleaning"}</span>
                        </div>
                      ) : (
                        <div key={`${x}-${y}`} role="gridcell" aria-label={`Empty cell column ${x + 1}, row ${y + 1}`} className="min-h-14 rounded border border-dashed border-slate-200" />
                      );
                    }),
                  )}
                </div>
              </div>
              <Card title={`Rooms on this floor (${plan.rooms.length})`}>
                {plan.rooms.length === 0 ? <p className="text-sm text-slate-500">No rooms assigned to this floor yet.</p> : (
                  <ul className="divide-y text-sm">
                    {plan.rooms.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>Room {r.number} <span className="text-slate-500">{r.layoutX === null ? "not placed" : `column ${r.layoutX + 1}, row ${r.layoutY! + 1}`}</span></span>
                        {canEdit && (
                          <form action={placeRoomAction} className="flex flex-wrap items-center gap-1">
                            <input type="hidden" name="roomId" value={r.id} />
                            <input type="hidden" name="floorId" value={plan.floor.id} />
                            <label className="text-xs">Column <input name="x" type="number" min={1} max={GRID_COLS} defaultValue={r.layoutX === null ? "" : r.layoutX + 1} className="w-14 rounded border border-slate-300 p-1" /></label>
                            <label className="text-xs">Row <input name="y" type="number" min={1} max={GRID_ROWS} defaultValue={r.layoutY === null ? "" : r.layoutY + 1} className="w-14 rounded border border-slate-300 p-1" /></label>
                            <button className={btn}>Place</button>
                            {r.layoutX !== null && <button name="clear" value="1" className={btnGhost}>Remove</button>}
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {unplaced.length > 0 && <p className="mt-2 text-xs text-slate-500">{unplaced.length} room(s) not placed on the grid yet.</p>}
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}
