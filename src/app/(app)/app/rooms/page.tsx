import Link from "next/link";
import { addRoomAction } from "@/app/actions";
import { bulkRoomsAction, reactivateRoomAction, archiveRoomAction } from "@/app/property-actions";
import { Badge, btn, btnGhost, Card, EmptyState, ErrorBanner, Field, input, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import ConfirmAction from "@/components/ConfirmAction";
import PropertyNav from "@/components/PropertyNav";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listRoomsAdmin, previewBulkRooms, type RoomFilter } from "@/server/services/property";
import { listRoomTypes } from "@/server/services/rooms";
import { listStructure } from "@/server/services/structure";
import { AppError } from "@/server/errors";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

function opState(r: { active: boolean; outOfOrder: boolean; inHouse: boolean; hasBookings: boolean }) {
  if (!r.active) return { label: "Archived", cls: "bg-slate-200 text-slate-800" };
  if (r.outOfOrder) return { label: "Out of order", cls: "bg-red-100 text-red-900" };
  if (r.inHouse) return { label: "Occupied", cls: "bg-green-100 text-green-900" };
  if (r.hasBookings) return { label: "Reserved", cls: "bg-blue-100 text-blue-900" };
  return { label: "Available", cls: "bg-emerald-50 text-emerald-900" };
}

export default async function Rooms({ searchParams }: PageProps<"/app/rooms">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const filter: RoomFilter = {
    q: one(sp.q), roomTypeId: one(sp.roomTypeId) || undefined, buildingId: one(sp.buildingId) || undefined, floorId: one(sp.floorId) || undefined,
    status: (["active", "archived", "all"] as const).find((s) => s === one(sp.status)) ?? "active", housekeeping: one(sp.housekeeping) || undefined,
  };
  const view = one(sp.view) === "cards" ? "cards" : "table";
  const [rooms, types, buildings] = await Promise.all([listRoomsAdmin(db, ctx, filter), listRoomTypes(db, ctx), listStructure(db, ctx)]);
  const floorOptions = buildings.flatMap((b) => b.floors.filter((f) => f.active).map((f) => ({ id: f.id, label: `${b.name} – ${f.label}`, buildingId: b.id })));
  const canManage = can("rooms.manage");
  const filtered = !!(filter.q || filter.roomTypeId || filter.buildingId || filter.floorId || filter.housekeeping || filter.status !== "active");

  // Bulk create: preview first (nothing is written), then confirm.
  let bulk: Awaited<ReturnType<typeof previewBulkRooms>> | null = null;
  let bulkError: string | null = null;
  const bulkIn = { roomTypeId: one(sp.bRoomTypeId), floorId: one(sp.bFloorId), prefix: one(sp.bPrefix), suffix: one(sp.bSuffix), from: one(sp.bFrom), to: one(sp.bTo) };
  if (canManage && one(sp.bulk) === "1") {
    try {
      bulk = await previewBulkRooms(db, ctx, { roomTypeId: bulkIn.roomTypeId, floorId: bulkIn.floorId || undefined, prefix: bulkIn.prefix, suffix: bulkIn.suffix, from: Number(bulkIn.from), to: Number(bulkIn.to) });
    } catch (e) {
      bulkError = e instanceof AppError ? e.message : "Check the range and category.";
    }
  }

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Rooms" }]} />
      <PageHeader
        title="Rooms"
        subtitle="Every room of the selected property: category, floor, status and who it is booked for."
        actions={<>
          <Link className={btnGhost} href="/app/rooms/import">Import CSV or Excel</Link>
          <Link className={btnGhost} href="/app/rooms/plan">Floor plan</Link>
        </>}
      />
      <PropertyNav current="rooms" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        {canManage && (
          <Card title="Add room">
            <form id="add-room" action={addRoomAction} className="space-y-3">
              <Field label="Room type">
                <select name="roomTypeId" required className={input}>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="Room number"><input name="number" required maxLength={20} className={input} /></Field>
              <Field label="Floor (optional)">
                <select name="floorId" className={input} defaultValue="">
                  <option value="">No floor</option>
                  {floorOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </Field>
              {floorOptions.length === 0 && <p className="text-xs text-slate-600">Define buildings and floors under Floors and layout.</p>}
              <button className={btn} disabled={types.length === 0}>Add</button>
              {types.length === 0 && <p className="text-xs text-slate-600">Create a room category first.</p>}
            </form>
          </Card>
        )}
        {canManage && (
          <Card title="Add many rooms">
            <form method="get" className="grid grid-cols-2 gap-2">
              <input type="hidden" name="bulk" value="1" />
              <Field label="Category">
                <select name="bRoomTypeId" defaultValue={bulkIn.roomTypeId} required className={input}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </Field>
              <Field label="Floor (optional)">
                <select name="bFloorId" defaultValue={bulkIn.floorId} className={input}><option value="">No floor</option>{floorOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
              </Field>
              <Field label="Prefix"><input name="bPrefix" defaultValue={bulkIn.prefix} maxLength={6} placeholder="e.g. A" className={input} /></Field>
              <Field label="Suffix"><input name="bSuffix" defaultValue={bulkIn.suffix} maxLength={4} className={input} /></Field>
              <Field label="First number"><input name="bFrom" type="number" min={0} required defaultValue={bulkIn.from} placeholder="101" className={input} /></Field>
              <Field label="Last number"><input name="bTo" type="number" min={0} required defaultValue={bulkIn.to} placeholder="110" className={input} /></Field>
              <div className="col-span-2"><button className={btnGhost}>Preview rooms</button></div>
            </form>
            {bulkError && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">{bulkError}</p>}
            {bulk && (
              <div className="mt-3 space-y-2 border-t pt-3 text-sm" role="status">
                <p>This would create <strong>{bulk.numbers.length}</strong> rooms in <strong>{bulk.category}</strong>{bulk.floor ? ` on ${bulk.floor}` : ""}:</p>
                <p className="break-words font-mono text-xs">{bulk.numbers.slice(0, 40).join(", ")}{bulk.numbers.length > 40 ? ` … ${bulk.numbers.at(-1)}` : ""}</p>
                {bulk.taken.length > 0 ? (
                  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-950">Already in use: {bulk.taken.slice(0, 10).join(", ")}{bulk.taken.length > 10 ? "…" : ""}. Change the range before creating.</p>
                ) : (
                  <form action={bulkRoomsAction}>
                    <input type="hidden" name="roomTypeId" value={bulkIn.roomTypeId} /><input type="hidden" name="floorId" value={bulkIn.floorId} />
                    <input type="hidden" name="prefix" value={bulkIn.prefix} /><input type="hidden" name="suffix" value={bulkIn.suffix} />
                    <input type="hidden" name="from" value={bulkIn.from} /><input type="hidden" name="to" value={bulkIn.to} />
                    <button className={btn}>Create {bulk.numbers.length} rooms</button>
                  </form>
                )}
              </div>
            )}
          </Card>
        )}
      </div>

      <form method="get" role="search" aria-label="Filter rooms" className="mb-3 grid gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-7">
        <label className="space-y-1 lg:col-span-2"><span className="text-xs font-medium text-slate-700">Search rooms</span><input name="q" defaultValue={filter.q} placeholder="Number or name" className={input} /></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Category</span>
          <select name="roomTypeId" defaultValue={filter.roomTypeId ?? ""} className={input}><option value="">All</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Building</span>
          <select name="buildingId" defaultValue={filter.buildingId ?? ""} className={input}><option value="">All</option>{buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Floor</span>
          <select name="floorId" defaultValue={filter.floorId ?? ""} className={input}><option value="">All</option>{buildings.flatMap((b) => b.floors).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Housekeeping</span>
          <select name="housekeeping" defaultValue={filter.housekeeping ?? ""} className={input}><option value="">Any</option>{["CLEAN", "INSPECTED", "DIRTY", "CLEANING"].map((h) => <option key={h} value={h}>{h.toLowerCase()}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Show</span>
          <select name="status" defaultValue={filter.status} className={input}><option value="active">Active rooms</option><option value="archived">Archived rooms</option><option value="all">All rooms</option></select></label>
        <label className="space-y-1"><span className="text-xs font-medium text-slate-700">View</span>
          <select name="view" defaultValue={view} className={input}><option value="table">Table</option><option value="cards">Cards</option></select></label>
        <div className="flex items-end gap-2 sm:col-span-3 lg:col-span-7">
          <button className={btn}>Apply</button>
          {filtered && <Link href="/app/rooms" className={btnGhost}>Clear filters</Link>}
        </div>
      </form>

      <Card title={`Rooms (${rooms.length})`}>
        {rooms.length === 0 ? (
          <EmptyState title={filtered ? "No rooms match these filters" : "No rooms yet"}>{filtered ? "Clear the filters to see every room." : "Add the first room above, or import many from a file."}</EmptyState>
        ) : view === "cards" ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rooms.map((r) => {
              const st = opState(r);
              return (
                <li key={r.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/app/rooms/${r.id}`} className="text-lg font-semibold text-slate-900 underline">{r.number}</Link>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
                  </div>
                  <p className="text-sm text-slate-700">{r.roomType.name}{r.name ? ` · ${r.name}` : ""}</p>
                  <p className="text-xs text-slate-600">{[r.building?.name, r.floorRef?.label].filter(Boolean).join(" · ") || "No floor"} · up to {r.roomType.maxAdults + r.roomType.maxChildren} guests · {inr(r.roomType.baseRateMinor)}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1"><Badge value={r.housekeeping} /></div>
                  <Actions r={r} canManage={canManage} />
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Rooms table, scrolls sideways">
            <table className="w-full min-w-[60rem] text-left text-sm">
              <thead className="text-xs text-slate-600">
                <tr>
                  <th scope="col" className="py-1 pr-2">Room</th><th scope="col" className="pr-2">Category</th><th scope="col" className="pr-2">Building and floor</th>
                  <th scope="col" className="pr-2">Max guests</th><th scope="col" className="pr-2 text-right">Base rate</th><th scope="col" className="pr-2">Status</th>
                  <th scope="col" className="pr-2">Housekeeping</th><th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rooms.map((r) => {
                  const st = opState(r);
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="py-2 pr-2"><Link className="font-medium underline" href={`/app/rooms/${r.id}`}>{r.number}</Link>{r.name && <span className="block text-xs text-slate-600">{r.name}</span>}</td>
                      <td className="pr-2">{r.roomType.name}{!r.roomType.active && <span className="block text-xs text-slate-600">inactive category</span>}</td>
                      <td className="pr-2">{[r.building?.name, r.floorRef?.label].filter(Boolean).join(" · ") || <span className="text-slate-600">No floor</span>}</td>
                      <td className="pr-2 tabular-nums">{r.roomType.maxAdults + r.roomType.maxChildren}</td>
                      <td className="pr-2 text-right tabular-nums">{inr(r.roomType.baseRateMinor)}</td>
                      <td className="pr-2"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                      <td className="pr-2"><Badge value={r.housekeeping} /></td>
                      <td><Actions r={r} canManage={canManage} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Actions({ r, canManage }: { r: { id: string; number: string; active: boolean; hasBookings: boolean }; canManage: boolean }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      <Link href={`/app/rooms/${r.id}`} className={btnGhost}>View</Link>
      {canManage && <Link href={`/app/rooms/${r.id}#edit`} className={btnGhost}>Edit</Link>}
      {canManage && r.active && (
        <ConfirmAction
          action={archiveRoomAction} fields={{ id: r.id, back: "/app/rooms" }} label="Archive" confirmLabel="Archive room" reasonLabel="Reason for archiving"
          title={`Archive room ${r.number}?`}
          impact={<>The room is removed from availability, the calendar and new bookings. Its past bookings, invoices and reports keep pointing to it. {r.hasBookings ? <strong>It has current or upcoming bookings, so archiving will be refused until those are moved.</strong> : "You can reactivate it later."}</>}
        />
      )}
      {canManage && !r.active && (
        <form action={reactivateRoomAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value="/app/rooms?status=archived" /><button className={btnGhost}>Reactivate</button></form>
      )}
    </div>
  );
}
