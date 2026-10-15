import Link from "next/link";
import { archiveRoomAction, deleteRoomAction, reactivateRoomAction, saveRoomAction } from "@/app/property-actions";
import { Badge, btn, btnGhost, Card, ErrorBanner, Field, input, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import ConfirmAction from "@/components/ConfirmAction";
import PropertyNav from "@/components/PropertyNav";
import UnsavedGuard from "@/components/UnsavedGuard";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { getRoom } from "@/server/services/property";
import { listCategories } from "@/server/services/property";
import { listStructure } from "@/server/services/structure";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function RoomDetail({ params, searchParams }: PageProps<"/app/rooms/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const canManage = roleHasPermission(ctx.role, "rooms.manage", ctx.extra);
  const [d, types, buildings] = await Promise.all([getRoom(db, ctx, id), listCategories(db, ctx, { status: "active" }), listStructure(db, ctx)]);
  const r = d.room;
  const floors = buildings.flatMap((b) => b.floors.filter((f) => f.active || f.id === r.floorId).map((f) => ({ id: f.id, label: `${b.name} – ${f.label}` })));
  const typeOptions = types.some((t) => t.id === r.roomTypeId) ? types : [...types, { ...r.roomType, roomCount: 0 }];
  const backToList = r.active ? "/app/rooms" : "/app/rooms?status=archived";

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Rooms", href: "/app/rooms" }, { label: `Room ${r.number}` }]} />
      <PageHeader
        title={`Room ${r.number}${r.name ? `: ${r.name}` : ""}`}
        subtitle={`${r.roomType.name} · ${[r.building?.name, r.floorRef?.label].filter(Boolean).join(" · ") || "No floor"}`}
        actions={<><Badge value={r.housekeeping} />{!r.active && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-800">Archived</span>}</>}
      />
      <PropertyNav current="rooms" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-600">Category</dt><dd>{r.roomType.name}{r.roomType.code ? ` (${r.roomType.code})` : ""}</dd>
            <dt className="text-slate-600">Max occupancy</dt><dd>{r.roomType.maxAdults} adults, {r.roomType.maxChildren} children</dd>
            <dt className="text-slate-600">Standard occupancy</dt><dd>{r.roomType.baseOccupancy}</dd>
            <dt className="text-slate-600">Default rate</dt><dd>{inr(r.roomType.baseRateMinor)} per night, before tax</dd>
            <dt className="text-slate-600">Bed</dt><dd>{r.roomType.bedConfig ?? "Not set"}</dd>
            <dt className="text-slate-600">Operational status</dt><dd>{r.outOfOrder ? "Out of order" : r.active ? "In service" : "Archived"}</dd>
            <dt className="text-slate-600">Bookings, all time</dt><dd>{d.stayCount}</dd>
          </dl>
          {d.stays.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <h3 className="text-sm font-medium">Current and upcoming bookings</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {d.stays.map((s) => <li key={s.reservationId}><Link className="underline" href={`/app/reservations/${s.reservationId}`}>{s.reference}</Link> {s.guest}, {s.arrival} to {s.departure} <Badge value={s.status} /></li>)}
              </ul>
            </div>
          )}
        </Card>

        {canManage && (
          <Card title="Edit room">
            <form id="edit" action={saveRoomAction} className="space-y-3">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="expectedUpdatedAt" value={r.updatedAt.toISOString()} />
              <Field label="Room number"><input name="number" defaultValue={r.number} required maxLength={20} className={input} /></Field>
              <Field label="Room name (optional)"><input name="name" defaultValue={r.name ?? ""} maxLength={60} placeholder="e.g. Sea View Suite" className={input} /></Field>
              <Field label="Category">
                <select name="roomTypeId" defaultValue={r.roomTypeId} className={input}>{typeOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </Field>
              <Field label="Floor">
                <select name="floorId" defaultValue={r.floorId ?? ""} className={input}><option value="">No floor</option>{floors.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
              </Field>
              <Field label="Notes (optional)"><textarea name="notes" rows={2} maxLength={500} defaultValue={r.notes ?? ""} className={input} /></Field>
              <div className="flex flex-wrap items-center gap-3">
                <button className={btn}>Save changes</button>
                <Link href={backToList} className={btnGhost}>Back to rooms</Link>
                <UnsavedGuard formId="edit" />
              </div>
              <p className="text-xs text-slate-600">A category change is refused while the room has current or upcoming bookings.</p>
            </form>
          </Card>
        )}
      </div>

      {canManage && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title={r.active ? "Archive" : "Reactivate"}>
            {r.active ? (
              <>
                <p className="mb-2 text-sm text-slate-700">Archiving takes the room out of availability and new bookings. Past reservations, invoices and reports keep their link to it. It is refused while the room holds an in-house guest or upcoming booking.</p>
                <ConfirmAction
                  action={archiveRoomAction} fields={{ id: r.id, back: `/app/rooms/${r.id}` }} label="Archive room" confirmLabel="Archive room" reasonLabel="Reason for archiving"
                  title={`Archive room ${r.number}?`} impact="It will no longer be offered for new bookings or shown on the calendar. You can reactivate it later."
                />
              </>
            ) : (
              <>
                <p className="mb-2 text-sm text-slate-700">Archived {r.archivedAt ? `on ${r.archivedAt.toISOString().slice(0, 10)}` : ""}. Reactivating returns it to availability.</p>
                <form action={reactivateRoomAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={`/app/rooms/${r.id}`} /><button className={btn}>Reactivate room</button></form>
              </>
            )}
          </Card>
          <Card title="Delete">
            {d.deleteBlockers.length > 0 ? (
              <p className="text-sm text-slate-700">This room cannot be deleted because it has {d.deleteBlockers.join(", ")}. Those records are kept, so archive it instead.</p>
            ) : (
              <>
                <p className="mb-2 text-sm text-slate-700">This room has never been used, so it can be deleted permanently. This cannot be undone.</p>
                <ConfirmAction action={deleteRoomAction} fields={{ id: r.id }} label="Delete room" confirmLabel="Delete permanently" title={`Delete room ${r.number}?`} impact="The room record is removed for good. Nothing else is affected." />
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
