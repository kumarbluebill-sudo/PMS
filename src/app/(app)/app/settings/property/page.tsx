import Link from "next/link";
import { createPropertyAction } from "@/app/settings-actions";
import { btn, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { ALL_PROPERTY_ROLES } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { listProperties, listRoomTypes } from "@/server/services/rooms";

export default async function PropertySettings({ searchParams }: PageProps<"/app/settings/property">) {
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to these settings.</p>;
  const [props, types] = await Promise.all([listProperties(db, ctx), listRoomTypes(db, ctx)]);
  const canAdd = roleHasPermission(ctx.role, "settings.manage", ctx.extra) && ALL_PROPERTY_ROLES.includes(ctx.role);
  return (
    <>
      <PageHeader title="Property & rooms" subtitle="Properties, room types, occupancy and floors." />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{ok}</p>}
      <div className="space-y-4">
        <Card title="Properties">
          <ul className="divide-y text-sm">
            {props.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><strong>{p.name}</strong> <span className="text-slate-500">{p.rooms} room(s), {p.roomTypes} room type(s) · {p.timezone}</span>{p.id === ctx.propertyId && <span className="ml-2 text-xs text-slate-500">(selected)</span>}</span>
              </li>
            ))}
          </ul>
          {canAdd ? (
            <form action={createPropertyAction} className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Add a property"><input name="name" required minLength={2} placeholder="Property name" className={input} /></Field>
              <button className={btn}>Add</button>
            </form>
          ) : <p className="mt-3 text-xs text-slate-500">Only an owner, group admin or general manager can add a property.</p>}
          <p className="mt-2 text-xs text-slate-500">Edit the selected property&apos;s name, address, time zone and check-in/out times under <Link className="underline" href="/app/settings/general">General</Link>.</p>
        </Card>
        <Card title="Room types (selected property)">
          {types.length === 0 ? <p className="text-sm text-slate-500">No room types yet.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500"><tr><th className="py-1">Name</th><th>Max adults</th><th>Max children</th><th>Base occupancy</th></tr></thead>
              <tbody className="divide-y">
                {types.map((t) => <tr key={t.id}><td className="py-1.5">{t.name}</td><td>{t.maxAdults}</td><td>{t.maxChildren}</td><td>{t.baseOccupancy}</td></tr>)}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-sm"><Link className="underline" href="/app/room-types">Manage room types and rates</Link> · <Link className="underline" href="/app/rooms">Manage rooms and floors</Link></p>
        </Card>
        <Card title="Out-of-order and housekeeping rules">
          <p className="text-sm text-slate-700">Blocked rooms leave sellable inventory for the dates they cover and come back needing cleaning. Rules, categories and approval are under <Link className="underline" href="/app/settings/rooms">Rooms &amp; housekeeping</Link>. Room amenities are not tracked yet.</p>
        </Card>
      </div>
    </>
  );
}
