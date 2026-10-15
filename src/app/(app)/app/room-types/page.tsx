import Link from "next/link";
import { addCategoryAction } from "@/app/property-actions";
import { btn, btnGhost, Card, EmptyState, ErrorBanner, Field, input, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import PropertyNav from "@/components/PropertyNav";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listCategories } from "@/server/services/property";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function RoomCategories({ searchParams }: PageProps<"/app/room-types">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const canManage = roleHasPermission(ctx.role, "rooms.manage", ctx.extra);
  const status = (["active", "inactive", "all"] as const).find((s) => s === one(sp.status)) ?? "active";
  const q = one(sp.q);
  const types = await listCategories(getDb(), ctx, { q, status });

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Room categories" }]} />
      <PageHeader title="Room categories" subtitle="Occupancy, beds, amenities and the default rate for each kind of room. Changing a rate never changes existing bookings." />
      <PropertyNav current="categories" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        {canManage && (
          <Card title="Add room category">
            <form id="add-category" action={addCategoryAction} className="space-y-3">
              <div className="grid grid-cols-[1fr_7rem] gap-2">
                <Field label="Name"><input name="name" required maxLength={80} className={input} /></Field>
                <Field label="Code"><input name="code" maxLength={12} placeholder="DLX" className={input} /></Field>
              </div>
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
        )}

        <div className="min-w-0 space-y-3">
          <form method="get" role="search" aria-label="Filter categories" className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3">
            <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Search categories</span><input name="q" defaultValue={q} placeholder="Category or code" className={input} /></label>
            <label className="space-y-1"><span className="text-xs font-medium text-slate-700">Show</span>
              <select name="status" defaultValue={status} className={input}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></label>
            <button className={btn}>Apply</button>
            {(q || status !== "active") && <Link href="/app/room-types" className={btnGhost}>Clear</Link>}
          </form>

          <Card title={`Categories (${types.length})`}>
            {types.length === 0 ? (
              <EmptyState title={q || status !== "active" ? "No categories match" : "No room categories yet"}>{q || status !== "active" ? "Clear the filters to see all." : "Add the first category to start adding rooms."}</EmptyState>
            ) : (
              <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Categories table, scrolls sideways">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="text-xs text-slate-600">
                    <tr><th scope="col" className="py-1 pr-2">Category</th><th scope="col" className="pr-2">Occupancy</th><th scope="col" className="pr-2 text-right">Base rate</th><th scope="col" className="pr-2 text-right">Rooms</th><th scope="col" className="pr-2">Status</th><th scope="col">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {types.map((t) => (
                      <tr key={t.id} className="align-top">
                        <td className="py-2 pr-2">
                          <Link className="font-medium underline" href={`/app/room-types/${t.id}`}>{t.name}</Link>{t.code && <span className="ml-1 font-mono text-xs text-slate-600">{t.code}</span>}
                          {t.bedConfig && <span className="block text-xs text-slate-600">{t.bedConfig}</span>}
                          {t.amenities.length > 0 && <span className="block text-xs text-slate-600">{t.amenities.slice(0, 5).join(" · ")}</span>}
                        </td>
                        <td className="pr-2">{t.baseOccupancy} standard, up to {t.maxAdults}A / {t.maxChildren}C{t.extraAdultRateMinor > 0 && <span className="block text-xs text-slate-600">Extra adult {inr(t.extraAdultRateMinor)}</span>}</td>
                        <td className="pr-2 text-right tabular-nums">{inr(t.baseRateMinor)}</td>
                        <td className="pr-2 text-right tabular-nums">{t.roomCount}</td>
                        <td className="pr-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.active ? "bg-emerald-50 text-emerald-900" : "bg-slate-200 text-slate-800"}`}>{t.active ? "Active" : "Inactive"}</span></td>
                        <td><div className="flex gap-1.5"><Link href={`/app/room-types/${t.id}`} className={btnGhost}>View</Link>{canManage && <Link href={`/app/room-types/${t.id}#edit`} className={btnGhost}>Edit</Link>}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
