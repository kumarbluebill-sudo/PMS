import { maintenanceAction } from "@/app/actions";
import { resolveMaintenanceAction } from "@/app/account-actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRooms } from "@/server/services/rooms";
import { listMaintenance } from "@/server/services/stays";

export default async function Maintenance({ searchParams }: PageProps<"/app/maintenance">) {
  const { error, roomId } = await searchParams;
  const ctx = await getCtx();
  const [rooms, items] = await Promise.all([listRooms(getDb(), ctx), listMaintenance(getDb(), ctx)]);
  return (
    <>
      <PageHeader title="Maintenance" subtitle="Rooms flagged as blocking are excluded from sellable inventory until resolved." />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="New request">
          <form action={maintenanceAction} className="space-y-3">
            <Field label="Room">
              <select name="roomId" required defaultValue={typeof roomId === "string" ? roomId : undefined} className={input}>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
              </select>
            </Field>
            <Field label="Issue"><input name="title" required className={input} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="blocksRoom" /> Block this room from sale</label>
            <button className={btn}>Create request</button>
          </form>
        </Card>
        <Card title="Requests">
          {items.length === 0 ? <p className="text-sm text-slate-500">No requests.</p> : (
            <ul className="divide-y text-sm">
              {items.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    Room {m.room.number}: {m.title} {m.blocksRoom && m.status !== "RESOLVED" && <span className="text-xs text-red-700">(blocking)</span>}
                  </span>
                  {m.status === "RESOLVED" ? <Badge value="CHECKED_OUT" /> : (
                    <form action={resolveMaintenanceAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <button className={btnGhost}>Resolve</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
