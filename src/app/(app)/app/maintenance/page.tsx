import { maintenanceAction } from "@/app/actions";
import { btn, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRooms } from "@/server/services/rooms";

export default async function Maintenance({ searchParams }: PageProps<"/app/maintenance">) {
  const { error } = await searchParams;
  const rooms = await listRooms(getDb(), await getCtx());
  return (
    <>
      <PageHeader title="Maintenance" subtitle="Rooms flagged as blocking are excluded from sellable inventory until resolved." />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <Card title="New request">
        <form action={maintenanceAction} className="max-w-md space-y-3">
          <Field label="Room">
            <select name="roomId" required className={input}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
            </select>
          </Field>
          <Field label="Issue"><input name="title" required className={input} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="blocksRoom" /> Block this room from sale</label>
          <button className={btn}>Create request</button>
        </form>
      </Card>
    </>
  );
}
