import Link from "next/link";
import { saveGuestAction } from "@/app/guest-actions";
import { Badge, btn, btnGhost, Card, EmptyState, ErrorBanner, Field, input, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import UnsavedGuard from "@/components/UnsavedGuard";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { getGuestProfile, guestHistory } from "@/server/services/guests";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function GuestPage({ params, searchParams }: PageProps<"/app/guests/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const canEdit = roleHasPermission(ctx.role, "guests.manage", ctx.extra);
  const [g, h] = await Promise.all([getGuestProfile(db, ctx, id), guestHistory(db, ctx, id)]);

  return (
    <>
      <Breadcrumbs items={[{ label: "Guests", href: "/app/guests" }, { label: g.name }]} />
      <PageHeader title={g.name} subtitle={`${h.totalStays} previous stay${h.totalStays === 1 ? "" : "s"} at this property${h.lastVisit ? `, last visit ${h.lastVisit}` : ""}`} />
      <ErrorBanner message={one(sp.error) || undefined} />
      {one(sp.ok) && <Notice tone="success">{one(sp.ok)}</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Guest profile">
          <p className="mb-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
            This is the guest&rsquo;s master profile. Changes apply to every future booking and are recorded in the audit log. Past reservations keep the details they were made with; special requests for one stay are edited on that reservation.
          </p>
          {canEdit ? (
            <form id="guest-form" action={saveGuestAction} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="id" value={g.id} />
              <input type="hidden" name="expectedUpdatedAt" value={g.updatedAt.toISOString()} />
              <div className="sm:col-span-2"><Field label="Full name"><input name="name" defaultValue={g.name} required maxLength={120} className={input} /></Field></div>
              <Field label="Mobile number"><input name="phone" type="tel" defaultValue={g.phone ?? ""} maxLength={30} className={input} /></Field>
              <Field label="Email"><input name="email" type="email" defaultValue={g.email ?? ""} maxLength={200} className={input} /></Field>
              <Field label="Nationality"><input name="nationality" defaultValue={g.nationality ?? ""} maxLength={60} className={input} /></Field>
              <Field label="Company"><input name="companyName" defaultValue={g.companyName ?? ""} maxLength={120} className={input} /></Field>
              <div className="sm:col-span-2"><Field label="Address"><input name="address" defaultValue={g.address ?? ""} maxLength={300} className={input} /></Field></div>
              <div className="sm:col-span-2"><Field label="Preferences"><textarea name="preferences" rows={2} maxLength={500} defaultValue={g.preferences ?? ""} placeholder="Quiet room, high floor, extra pillows" className={input} /></Field></div>
              <div className="sm:col-span-2"><Field label="Service notes"><textarea name="notes" rows={2} maxLength={1000} defaultValue={g.notes ?? ""} className={input} /></Field></div>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2"><button className={btn}>Save profile</button><Link href="/app/guests" className={btnGhost}>Back to guests</Link><UnsavedGuard formId="guest-form" /></div>
              <p className="text-xs text-slate-600 sm:col-span-2">{g.idRecorded ? `An ID (${g.idType?.replace("_", " ").toLowerCase() ?? "document"}) is on file. The number is stored encrypted and is never shown here.` : "No ID is on file."}</p>
            </form>
          ) : (
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-600">Mobile</dt><dd>{g.phone ?? "Not shown"}</dd><dt className="text-slate-600">Email</dt><dd>{g.email ?? "Not shown"}</dd>
              <dt className="text-slate-600">Nationality</dt><dd>{g.nationality ?? "Not recorded"}</dd>
            </dl>
          )}
        </Card>

        <Card title="Stay history">
          {h.outstandingMinor !== null && h.outstandingMinor > 0 && <p className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">Open balance on current stays: <strong>{inr(h.outstandingMinor)}</strong></p>}
          {h.preferences && <p className="mb-2 text-sm"><span className="font-medium">Preferences:</span> {h.preferences}</p>}
          {h.reservations.length === 0 ? (
            <EmptyState title="No bookings at this property yet">Their first booking will appear here.</EmptyState>
          ) : (
            <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Stay history, scrolls sideways">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <thead className="text-xs text-slate-600"><tr><th scope="col" className="py-1 pr-2">Reference</th><th scope="col" className="pr-2">Stay</th><th scope="col" className="pr-2">Room</th><th scope="col">Status</th></tr></thead>
                <tbody className="divide-y">
                  {h.reservations.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-2 font-mono text-xs"><Link className="underline" href={`/app/reservations/${r.id}`}>{r.reference}</Link></td>
                      <td className="whitespace-nowrap pr-2">{r.arrival} to {r.departure}</td>
                      <td className="pr-2">{r.category}{r.room ? ` · ${r.room}` : ""}</td>
                      <td><Badge value={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-sm"><Link className={btnGhost} href={`/app/reservations/new`}>New reservation</Link></p>
        </Card>
      </div>
    </>
  );
}
