import Link from "next/link";
import { updatePropertyAction } from "@/app/account-actions";
import { btn, Card, ErrorBanner, Field, input } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { getCtx } from "@/server/session";

export default async function Onboarding({ searchParams }: PageProps<"/onboarding">) {
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const data = await withTenant(db, ctx.tenantId, async (tx) => ({
    property: ctx.propertyId ? await tx.property.findUnique({ where: { id: ctx.propertyId } }) : null,
    types: await tx.roomType.count({ where: { propertyId: ctx.propertyId ?? undefined } }),
    rooms: await tx.room.count({ where: { propertyId: ctx.propertyId ?? undefined } }),
  }));
  const members = await db.membership.count({ where: { tenantId: ctx.tenantId, active: true } });
  const p = data.property;
  const steps = [
    { done: !!p?.address, label: "Property details", href: "#property", note: "Address, timezone, check-in and check-out times" },
    { done: data.types > 0, label: "Room types", href: "/app/room-types", note: "Define categories, occupancy and base rates" },
    { done: data.rooms > 0, label: "Rooms", href: "/app/rooms", note: "Add room numbers under each type" },
    { done: members > 1, label: "Team", href: "/app/users", note: "Invite front desk, housekeeping and managers" },
    { done: ctx.mfaEnabled, label: "Two-factor authentication", href: "/security", note: "Required for owners and managers" },
  ];
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Set up your property</h1>
      <p className="text-sm text-slate-600">
        You can start taking bookings once rooms exist. Tax (GST), billing and channel setup arrive with later releases.
      </p>
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="text-sm text-green-800">{ok}</p>}
      <Card title="Checklist">
        <ol className="space-y-2 text-sm">
          {steps.map((s) => (
            <li key={s.label} className="flex items-start gap-2">
              <span aria-label={s.done ? "done" : "to do"}>{s.done ? "✅" : "⬜"}</span>
              <span>
                <Link href={s.href} className="font-medium underline">{s.label}</Link>
                <span className="block text-xs text-slate-500">{s.note}</span>
              </span>
            </li>
          ))}
        </ol>
        <Link href="/app/dashboard" className={`${btn} mt-4`}>Go to dashboard</Link>
      </Card>
      {p && (
        <Card title="Property details">
          <form id="property" action={updatePropertyAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Property name"><input name="name" defaultValue={p.name} required className={input} /></Field>
            <Field label="Timezone"><input name="timezone" defaultValue={p.timezone} required className={input} /></Field>
            <div className="sm:col-span-2">
              <Field label="Address"><input name="address" defaultValue={p.address ?? ""} className={input} /></Field>
            </div>
            <Field label="Check-in time"><input name="checkInTime" type="time" defaultValue={p.checkInTime} required className={input} /></Field>
            <Field label="Check-out time"><input name="checkOutTime" type="time" defaultValue={p.checkOutTime} required className={input} /></Field>
            <div><button className={btn}>Save</button></div>
          </form>
        </Card>
      )}
    </main>
  );
}
