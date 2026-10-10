import { addRoomTypeAction } from "@/app/actions";
import { btn, Card, ErrorBanner, Field, input, inr, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRoomTypes } from "@/server/services/rooms";

export default async function RoomTypes({ searchParams }: PageProps<"/app/room-types">) {
  const { error } = await searchParams;
  const types = await listRoomTypes(getDb(), await getCtx());
  return (
    <>
      <PageHeader title="Room types" />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Add room type">
          <form action={addRoomTypeAction} className="space-y-3">
            <Field label="Name"><input name="name" required className={input} /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Max adults"><input name="maxAdults" type="number" min={1} defaultValue={2} className={input} /></Field>
              <Field label="Max children"><input name="maxChildren" type="number" min={0} defaultValue={0} className={input} /></Field>
              <Field label="Base rate (₹)"><input name="baseRate" type="number" min={0} step="0.01" className={input} /></Field>
            </div>
            <button className={btn}>Add</button>
          </form>
        </Card>
        <Card title="Existing">
          {types.length === 0 ? <p className="text-sm text-slate-500">No room types yet.</p> : (
            <ul className="divide-y text-sm">
              {types.map((t) => (
                <li key={t.id} className="flex justify-between py-2">
                  <span>{t.name} <span className="text-slate-500">({t.maxAdults}A/{t.maxChildren}C)</span></span>
                  <span>{inr(t.baseRateMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
