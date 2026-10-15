import Link from "next/link";
import { switchPropertyAction } from "@/app/actions";
import { btn, btnGhost, Card, ErrorBanner, input, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import PropertyNav from "@/components/PropertyNav";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listCategories, listRatePlans, listRoomsAdmin, propertyOverview } from "@/server/services/property";
import { listProperties } from "@/server/services/rooms";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PropertyOverview({ searchParams }: PageProps<"/app/property">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const o = await propertyOverview(db, ctx);
  const props = can("settings.view") ? await listProperties(db, ctx) : [];
  const q = one(sp.q).trim();
  const found = q.length >= 2
    ? await Promise.all([listRoomsAdmin(db, ctx, { q, status: "all" }), listCategories(db, ctx, { q, status: "all" }), listRatePlans(db, ctx, { q, status: "all" })]).then(([rooms, categories, plans]) => ({ rooms: rooms.slice(0, 10), categories, plans: plans.plans }))
    : null;
  const p = o.property;

  const stats: { label: string; value: number; sub?: string; href: string }[] = [
    { label: "Rooms", value: o.rooms, sub: o.archivedRooms ? `${o.archivedRooms} archived` : undefined, href: "/app/rooms" },
    { label: "Room categories", value: o.categories, sub: o.inactiveCategories ? `${o.inactiveCategories} inactive` : undefined, href: "/app/room-types" },
    { label: "Floors", value: o.floors, sub: `${o.buildings} building${o.buildings === 1 ? "" : "s"}`, href: "/app/structure" },
    { label: "Active rate plans", value: o.activePlans, sub: o.totalPlans > o.activePlans ? `${o.totalPlans - o.activePlans} archived` : undefined, href: "/app/rates" },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management" }, { label: "Overview" }]} />
      <PageHeader
        title="Property management"
        subtitle={`${p.name}${p.code ? ` (${p.code})` : ""} · ${p.status.toLowerCase()}`}
        actions={<>
          {can("rooms.manage") && <Link href="/app/rooms#add-room" className={btn}>Add room</Link>}
          {can("rooms.manage") && <Link href="/app/room-types#add-category" className={btnGhost}>Add category</Link>}
          {can("rates.manage") && <Link href="/app/rates/new" className={btnGhost}>Add rate plan</Link>}
          {can("settings.manage") && <Link href="/app/settings/property#add-property" className={btnGhost}>Add property</Link>}
        </>}
      />
      <PropertyNav current="overview" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        {props.length > 1 && (
          <form action={switchPropertyAction} className="flex items-end gap-2">
            <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Property</span>
              <select name="propertyId" defaultValue={ctx.propertyId ?? ""} className={input}>{props.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <button className={btnGhost}>Switch</button>
          </form>
        )}
        <form method="get" role="search" aria-label="Search property records" className="flex items-end gap-2">
          <label className="block space-y-1"><span className="text-sm font-medium text-slate-700">Search rooms, categories and rate plans</span>
            <input name="q" defaultValue={q} minLength={2} placeholder="Room number, category or plan" className={input} /></label>
          <button className={btnGhost}>Search</button>
        </form>
      </div>

      <ul aria-label="Property summary" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <li key={s.label}>
            <Link href={s.href} className="block rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:border-brand-600">
              <span className="block text-xs text-slate-600">{s.label}</span>
              <span className="block text-2xl font-semibold tabular-nums text-slate-900">{s.value}</span>
              <span className="block min-h-4 text-xs text-slate-600">{s.sub ?? ""}</span>
            </Link>
          </li>
        ))}
      </ul>

      {found && (
        <Card title={`Results for "${q}"`}>
          <ul className="space-y-1 text-sm">
            {found.rooms.map((r) => <li key={r.id}>Room <Link className="underline" href={`/app/rooms/${r.id}`}>{r.number}</Link> <span className="text-slate-600">{r.roomType.name}{r.active ? "" : ", archived"}</span></li>)}
            {found.categories.map((c) => <li key={c.id}>Category <Link className="underline" href={`/app/room-types/${c.id}`}>{c.name}</Link> <span className="text-slate-600">{c.code ?? ""}{c.active ? "" : " inactive"}</span></li>)}
            {found.plans.map((r) => <li key={r.id}>Rate plan <Link className="underline" href={`/app/rates/${r.id}`}>{r.name}</Link> <span className="text-slate-600">{r.code}</span></li>)}
            {found.rooms.length + found.categories.length + found.plans.length === 0 && <li className="text-slate-600">Nothing found.</li>}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Property profile" actions={can("settings.manage") ? <Link className={btnGhost} href="/app/settings/property">Edit</Link> : undefined}>
          <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-600">Name</dt><dd>{p.name}</dd>
            <dt className="text-slate-600">Code</dt><dd>{p.code ?? "Not set"}</dd>
            <dt className="text-slate-600">Contact</dt><dd>{[p.phone, p.email].filter(Boolean).join(" · ") || "Not set"}</dd>
            <dt className="text-slate-600">Address</dt><dd>{p.address ?? "Not set"}</dd>
            <dt className="text-slate-600">Check-in / out</dt><dd>{p.checkInTime} / {p.checkOutTime}</dd>
            <dt className="text-slate-600">Time zone, currency</dt><dd>{p.timezone}, {p.currency}</dd>
            <dt className="text-slate-600">GST</dt><dd>{p.gstRegistered ? `Registered, ${p.gstin}` : "Not registered"}</dd>
          </dl>
        </Card>
        <Card title="Where to manage things">
          <ul className="space-y-2 text-sm">
            <li><Link className="underline" href="/app/rooms">Rooms</Link>: add, edit, assign a category or floor, archive. Bulk add and CSV or Excel import are on the same page.</li>
            <li><Link className="underline" href="/app/room-types">Room categories</Link>: occupancy, bed type, amenities, base and extra-person rates.</li>
            <li><Link className="underline" href="/app/structure">Floors and layout</Link>: buildings, floors, assigning rooms, the floor plan.</li>
            <li><Link className="underline" href="/app/rates">Rate plans</Link>: seasonal, weekend and meal-plan rates, with a preview by date.</li>
            <li><Link className="underline" href="/app/settings/rooms">Room status colours</Link> and <Link className="underline" href="/app/settings/permissions">staff permissions</Link>.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
