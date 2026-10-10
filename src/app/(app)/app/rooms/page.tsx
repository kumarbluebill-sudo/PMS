import { addRoomAction } from "@/app/actions";
import { Badge, btn, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRooms, listRoomTypes } from "@/server/services/rooms";

export default async function Rooms({ searchParams }: PageProps<"/app/rooms">) {
  const { error } = await searchParams;
  const ctx = await getCtx();
  const [rooms, types] = await Promise.all([listRooms(getDb(), ctx), listRoomTypes(getDb(), ctx)]);
  return (
    <>
      <PageHeader title="Rooms" />
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
            <button className={btn} disabled={types.length === 0}>Add</button>
            {types.length === 0 && <p className="text-xs text-slate-500">Create a room type first.</p>}
          </form>
        </Card>
        <Card title={`Rooms (${rooms.length})`}>
          <ul className="divide-y text-sm">
            {rooms.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <span>{r.number} <span className="text-slate-500">{r.roomType.name}</span></span>
                <Badge value={r.housekeeping} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
