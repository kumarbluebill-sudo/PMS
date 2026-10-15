import Link from "next/link";
import { createPropertyAction } from "@/app/settings-actions";
import { deletePropertyAction, propertyStatusAction, saveProfileAction } from "@/app/property-actions";
import { btn, Card, ErrorBanner, Field, input, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import ConfirmAction from "@/components/ConfirmAction";
import PropertyNav from "@/components/PropertyNav";
import UnsavedGuard from "@/components/UnsavedGuard";
import { ALL_PROPERTY_ROLES } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { propertyOverview } from "@/server/services/property";
import { listProperties } from "@/server/services/rooms";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PropertySettings({ searchParams }: PageProps<"/app/settings/property">) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to these settings.</p>;
  const canEdit = roleHasPermission(ctx.role, "settings.manage", ctx.extra);
  const canAdd = canEdit && ALL_PROPERTY_ROLES.includes(ctx.role);
  const [props, o] = await Promise.all([listProperties(db, ctx), propertyOverview(db, ctx)]);
  const p = o.property;
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["Asia/Kolkata"];
  const others = props.filter((x) => x.id !== p.id);

  return (
    <>
      <Breadcrumbs items={[{ label: "Property management", href: "/app/property" }, { label: "Property settings" }]} />
      <PageHeader title="Property settings" subtitle="The hotel's profile, contact details, timings and status." />
      <PropertyNav current="settings" />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="space-y-4">
        <Card title="Hotel profile">
          {canEdit ? (
            <form id="profile" action={saveProfileAction} className="space-y-3">
              <input type="hidden" name="expectedUpdatedAt" value={p.updatedAt.toISOString()} />
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2"><Field label="Hotel name"><input name="name" defaultValue={p.name} required minLength={2} maxLength={120} className={input} /></Field></div>
                <Field label="Property code"><input name="code" defaultValue={p.code ?? ""} maxLength={12} placeholder="PALM" className={input} /></Field>
                <Field label="Registered address"><textarea name="address" rows={2} maxLength={300} defaultValue={p.address ?? ""} className={input} /></Field>
                <Field label="Operational address (if different)"><textarea name="operationalAddress" rows={2} maxLength={300} defaultValue={p.operationalAddress ?? ""} className={input} /></Field>
                <div className="space-y-3">
                  <Field label="Phone"><input name="phone" type="tel" defaultValue={p.phone ?? ""} maxLength={30} className={input} /></Field>
                  <Field label="Email"><input name="email" type="email" defaultValue={p.email ?? ""} maxLength={200} className={input} /></Field>
                </div>
                <Field label="Time zone"><input name="timezone" list="zones" defaultValue={p.timezone} required className={input} /></Field>
                <Field label="Currency"><input name="currency" defaultValue={p.currency} required maxLength={3} className={input} /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Check-in time"><input name="checkInTime" type="time" defaultValue={p.checkInTime} required className={input} /></Field>
                  <Field label="Check-out time"><input name="checkOutTime" type="time" defaultValue={p.checkOutTime} required className={input} /></Field>
                </div>
              </div>
              <datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
              <Field label="Description"><textarea name="description" rows={3} maxLength={1000} defaultValue={p.description ?? ""} className={input} /></Field>
              <Field label="Amenities (comma separated)"><input name="amenities" defaultValue={p.amenities.join(", ")} placeholder="Pool, Spa, Parking, Restaurant" className={input} /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Logo link (https)"><input name="logoUrl" type="url" defaultValue={p.logoUrl ?? ""} placeholder="https://" className={input} /></Field>
                <Field label="Property image links (https, one per line)"><textarea name="imageUrls" rows={2} defaultValue={p.imageUrls.join("\n")} className={input} /></Field>
              </div>
              <div className="flex flex-wrap items-center gap-3"><button className={btn}>Save profile</button><UnsavedGuard formId="profile" /></div>
              <p className="text-xs text-slate-600">Logo and photos are links to images hosted elsewhere; file upload is not available yet.</p>
            </form>
          ) : (
            <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-600">Name</dt><dd>{p.name}</dd><dt className="text-slate-600">Code</dt><dd>{p.code ?? "Not set"}</dd>
              <dt className="text-slate-600">Contact</dt><dd>{[p.phone, p.email].filter(Boolean).join(" · ") || "Not set"}</dd><dt className="text-slate-600">Address</dt><dd>{p.address ?? "Not set"}</dd>
            </dl>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="GST and billing">
            <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-600">GST registration</dt><dd>{p.gstRegistered ? "Registered" : "Not registered"}</dd>
              <dt className="text-slate-600">GSTIN</dt><dd className="font-mono">{p.gstin ?? "Not set"}</dd>
              <dt className="text-slate-600">Legal name</dt><dd>{p.legalName ?? "Not set"}</dd>
              <dt className="text-slate-600">Invoice prefix</dt><dd className="font-mono">{p.invoicePrefix}</dd>
            </dl>
            <p className="mt-3 text-sm text-slate-700">GST details are changed under <Link className="underline" href="/app/settings/tax">GST and tax</Link>, where each change needs a reason and is recorded.</p>
          </Card>

          <Card title="Status">
            <p className="mb-2 text-sm text-slate-700">This property is <strong>{p.status.toLowerCase()}</strong>. Deactivating is refused while it has current or upcoming reservations. Records are never removed.</p>
            {canAdd && p.status === "ACTIVE" && (
              <ConfirmAction action={propertyStatusAction} fields={{ status: "INACTIVE" }} label="Deactivate property" confirmLabel="Deactivate" reasonLabel="Reason" title={`Deactivate ${p.name}?`} impact="Staff can still see its history, but it should not take new bookings. Reactivate it any time." />
            )}
            {canAdd && p.status !== "ACTIVE" && <form action={propertyStatusAction}><input type="hidden" name="status" value="ACTIVE" /><button className={btn}>Reactivate property</button></form>}
            {!canAdd && <p className="text-xs text-slate-600">Only an owner, group admin or general manager can change the status.</p>}
            {canAdd && (
              <p className="mt-3 border-t pt-3 text-sm text-slate-700">
                <strong>Delete:</strong> a property with reservations, folios, invoices, rooms or staff cannot be deleted. Only a property that was never used can be, and only when the business keeps another one.{" "}
                {others.length > 0 && <span>Switch to the property first, then use Delete.</span>}
              </p>
            )}
            {canAdd && (
              <div className="mt-2">
                <ConfirmAction action={deletePropertyAction} fields={{ id: p.id }} label="Delete property" confirmLabel="Delete permanently" title={`Delete ${p.name}?`} impact="This only works if the property has no records at all. Otherwise it is refused and nothing changes." />
              </div>
            )}
          </Card>
        </div>

        <Card title="Properties in this business">
          <ul className="divide-y text-sm">
            {props.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><strong>{x.name}</strong>{x.code ? <span className="ml-1 font-mono text-xs">{x.code}</span> : null} <span className="text-slate-600">{x.rooms} room(s), {x.roomTypes} categor{x.roomTypes === 1 ? "y" : "ies"} · {x.timezone} · {x.status.toLowerCase()}</span>{x.id === ctx.propertyId && <span className="ml-2 text-xs text-slate-600">(selected)</span>}</span>
              </li>
            ))}
          </ul>
          {canAdd ? (
            <form id="add-property" action={createPropertyAction} className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Add a property"><input name="name" required minLength={2} placeholder="Property name" className={input} /></Field>
              <button className={btn}>Add</button>
            </form>
          ) : <p className="mt-3 text-xs text-slate-600">Only an owner, group admin or general manager can add a property.</p>}
        </Card>

        <Card title="Other settings for rooms and staff">
          <ul className="space-y-1.5 text-sm">
            <li><Link className="underline" href="/app/settings/rooms">Room-status colours and housekeeping rules</Link></li>
            <li><Link className="underline" href="/app/settings/reservations">Reservation and front-office defaults</Link></li>
            <li><Link className="underline" href="/app/settings/permissions">Staff roles and permissions</Link></li>
            <li><Link className="underline" href="/app/settings/general">All general settings</Link></li>
          </ul>
        </Card>
      </div>
    </>
  );
}
