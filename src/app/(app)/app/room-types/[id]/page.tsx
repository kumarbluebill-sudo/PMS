import Link from "next/link";
import { categoryActiveAction, deleteCategoryAction, reassignRoomsAction, saveCategoryAction } from "@/app/property-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import ConfirmAction from "@/components/ConfirmAction";
import PropertyNav from "@/components/PropertyNav";
import UnsavedGuard from "@/components/UnsavedGuard";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { getCategory, listCategories } from "@/server/services/property";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const rupees = (minor: number) => (minor / 100).toFixed(2);

export default async function CategoryDetail({ params, searchParams }: PageProps<"/app/room-types/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const canManage = roleHasPermission(ctx.role, "rooms.manage", ctx.extra);
  const [d, others] = await Promise.all([getCategory(db, ctx, id), listCategories(db, ctx, { status: "active" })]);
  const t = d.type;
  const targets = others.filter((x) => x.id !== t.id);
  const activeRooms = d.rooms.filter((r) => r.active);

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Room categories", href: "/app/room-types" }, { label: t.name }]} />
      <PageHeader
        title={`${t.name}${t.code ? ` (${t.code})` : ""}`}
        subtitle={`${t.baseOccupancy} standard, up to ${t.maxAdults} adults and ${t.maxChildren} children · ${inr(t.baseRateMinor)} per night before tax`}
        actions={<span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.active ? "bg-emerald-50 text-emerald-900" : "bg-slate-200 text-slate-800"}`}>{t.active ? "Active" : "Inactive"}</span>}
      />
      <PropertyNav current="categories" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Where it is used">
          <dl className="grid grid-cols-[11rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-600">Rooms</dt><dd>{activeRooms.length} active{d.rooms.length > activeRooms.length ? `, ${d.rooms.length - activeRooms.length} archived` : ""}</dd>
            <dt className="text-slate-600">Reservations, all time</dt><dd>{d.reservations}</dd>
            <dt className="text-slate-600">Current and upcoming</dt><dd>{d.futureReservations}</dd>
            <dt className="text-slate-600">Rate plan lines</dt><dd>{d.planLines}</dd>
            <dt className="text-slate-600">Bed</dt><dd>{t.bedConfig ?? "Not set"}</dd>
            <dt className="text-slate-600">Amenities</dt><dd>{t.amenities.join(", ") || "None"}</dd>
          </dl>
          {d.rooms.length > 0 && <p className="mt-3 text-sm text-slate-700">Rooms: {d.rooms.map((r, i) => <span key={r.id}>{i > 0 && ", "}<Link className="underline" href={`/app/rooms/${r.id}`}>{r.number}</Link>{r.active ? "" : " (archived)"}</span>)}</p>}
          {t.imageUrls.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2">
              {t.imageUrls.map((u) => (
                // Photos are external https links; no upload storage is set up yet.
                // eslint-disable-next-line @next/next/no-img-element
                <li key={u}><img src={u} alt={`${t.name} photo`} loading="lazy" className="h-20 w-full rounded object-cover" /></li>
              ))}
            </ul>
          )}
        </Card>

        {canManage && (
          <Card title="Edit category">
            <form id="edit" action={saveCategoryAction} className="space-y-3">
              <input type="hidden" name="id" value={t.id} />
              <input type="hidden" name="expectedUpdatedAt" value={t.updatedAt.toISOString()} />
              <div className="grid grid-cols-[1fr_7rem] gap-2">
                <Field label="Name"><input name="name" defaultValue={t.name} required maxLength={80} className={input} /></Field>
                <Field label="Code"><input name="code" defaultValue={t.code ?? ""} maxLength={12} className={input} /></Field>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Standard occupancy"><input name="baseOccupancy" type="number" min={1} defaultValue={t.baseOccupancy} className={input} /></Field>
                <Field label="Max adults"><input name="maxAdults" type="number" min={1} defaultValue={t.maxAdults} className={input} /></Field>
                <Field label="Max children"><input name="maxChildren" type="number" min={0} defaultValue={t.maxChildren} className={input} /></Field>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Base rate (₹)"><input name="baseRate" inputMode="decimal" defaultValue={rupees(t.baseRateMinor)} className={input} /></Field>
                <Field label="Extra adult (₹/night)"><input name="extraAdultRate" inputMode="decimal" defaultValue={rupees(t.extraAdultRateMinor)} className={input} /></Field>
                <Field label="Extra child (₹/night)"><input name="extraChildRate" inputMode="decimal" defaultValue={rupees(t.extraChildRateMinor)} className={input} /></Field>
              </div>
              <Field label="Bed type and count"><input name="bedConfig" defaultValue={t.bedConfig ?? ""} placeholder="1 King or 2 Twin" className={input} /></Field>
              <Field label="Amenities (comma separated)"><input name="amenities" defaultValue={t.amenities.join(", ")} className={input} /></Field>
              <Field label="Photo links (https, one per line)"><textarea name="imageUrls" rows={2} defaultValue={t.imageUrls.join("\n")} className={input} /></Field>
              <Field label="Description"><textarea name="description" rows={2} maxLength={500} defaultValue={t.description ?? ""} className={input} /></Field>
              <p className="text-xs text-slate-600">A new rate applies to bookings made after you save. Existing bookings keep the rate they were booked at.</p>
              <div className="flex flex-wrap items-center gap-3"><button className={btn}>Save changes</button><Link href="/app/room-types" className={btnGhost}>Back to categories</Link><UnsavedGuard formId="edit" /></div>
            </form>
          </Card>
        )}
      </div>

      {canManage && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title={t.active ? "Deactivate" : "Reactivate"}>
            {t.active ? (
              <>
                <p className="mb-2 text-sm text-slate-700">Deactivating stops new bookings and new rooms in this category. Existing reservations, invoices and reports are untouched.{d.futureReservations > 0 && <strong> {d.futureReservations} current or upcoming reservation{d.futureReservations === 1 ? "" : "s"} will keep their rooms and rates.</strong>}</p>
                <ConfirmAction action={categoryActiveAction} fields={{ id: t.id, active: "false" }} label="Deactivate category" confirmLabel="Deactivate" reasonLabel="Reason for deactivating" title={`Deactivate ${t.name}?`} impact="It will no longer be offered when booking. Reactivate it any time." />
              </>
            ) : (
              <form action={categoryActiveAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="active" value="true" /><button className={btn}>Reactivate category</button></form>
            )}
          </Card>

          <Card title="Move rooms to another category">
            {activeRooms.length === 0 || targets.length === 0 ? (
              <p className="text-sm text-slate-700">{activeRooms.length === 0 ? "This category has no active rooms to move." : "Create another active category to move rooms into."}</p>
            ) : (
              <form action={reassignRoomsAction} className="space-y-2">
                <input type="hidden" name="fromTypeId" value={t.id} />
                <fieldset className="grid max-h-40 grid-cols-3 gap-1 overflow-y-auto text-sm sm:grid-cols-4">
                  <legend className="mb-1 text-sm font-medium text-slate-700">Rooms to move</legend>
                  {activeRooms.map((r) => <label key={r.id} className="flex items-center gap-1.5"><input type="checkbox" name="roomIds" value={r.id} />{r.number}</label>)}
                </fieldset>
                <Field label="Move to"><select name="toTypeId" className={input}>{targets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
                <button className={btnGhost}>Move selected rooms</button>
                <p className="text-xs text-slate-600">Rooms with current or upcoming bookings cannot move until those bookings are moved. Nothing changes if any selected room is blocked.</p>
              </form>
            )}
          </Card>

          <Card title="Delete">
            {d.rooms.length > 0 || d.reservations > 0 || d.planLines > 0 ? (
              <p className="text-sm text-slate-700">This category cannot be deleted because it has {[d.rooms.length && `${d.rooms.length} room${d.rooms.length === 1 ? "" : "s"}`, d.reservations && `${d.reservations} reservation${d.reservations === 1 ? "" : "s"}`, d.planLines && `${d.planLines} rate plan line${d.planLines === 1 ? "" : "s"}`].filter(Boolean).join(", ")}. Deactivate it instead; history is kept.</p>
            ) : (
              <>
                <p className="mb-2 text-sm text-slate-700">Nothing uses this category, so it can be deleted permanently.</p>
                <ConfirmAction action={deleteCategoryAction} fields={{ id: t.id }} label="Delete category" confirmLabel="Delete permanently" title={`Delete ${t.name}?`} impact="The category is removed for good. This cannot be undone." />
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
