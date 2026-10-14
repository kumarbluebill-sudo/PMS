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
              <Field label="Base occupancy"><input name="baseOccupancy" type="number" min={1} defaultValue={2} className={input} /></Field>
              <Field label="Extra adult (₹/night)"><input name="extraAdultRate" inputMode="decimal" className={input} /></Field>
              <Field label="Extra child (₹/night)"><input name="extraChildRate" inputMode="decimal" className={input} /></Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Max adults"><input name="maxAdults" type="number" min={1} defaultValue={2} className={input} /></Field>
              <Field label="Max children"><input name="maxChildren" type="number" min={0} defaultValue={0} className={input} /></Field>
              <Field label="Base rate (₹)"><input name="baseRate" type="number" min={0} step="0.01" className={input} /></Field>
            </div>
            <Field label="Bed configuration"><input name="bedConfig" placeholder="1 King or 2 Twin" className={input} /></Field>
            <Field label="Amenities (comma separated)"><input name="amenities" placeholder="AC, WiFi, TV, Minibar" className={input} /></Field>
            <Field label="Description"><textarea name="description" rows={2} maxLength={500} className={input} /></Field>
            <button className={btn}>Add</button>
          </form>
        </Card>
        <Card title="Existing">
          {types.length === 0 ? <p className="text-sm text-slate-500">No room types yet.</p> : (
            <ul className="divide-y text-sm">
              {types.map((t) => (
                <li key={t.id} className="flex justify-between py-2">
                  <span>{t.name} <span className="text-slate-500">({t.maxAdults}A/{t.maxChildren}C)</span>{t.bedConfig && <span className="block text-xs text-slate-500">{t.bedConfig}</span>}{t.amenities.length > 0 && <span className="block text-xs text-slate-500">{t.amenities.join(" · ")}</span>}{t.extraAdultRateMinor > 0 &&<span className="block text-xs text-slate-500">Extra adult {inr(t.extraAdultRateMinor)} beyond {t.baseOccupancy}</span>}</span>
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
