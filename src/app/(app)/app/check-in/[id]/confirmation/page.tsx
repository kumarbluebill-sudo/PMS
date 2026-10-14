import Link from "next/link";
import { fmtDate, Notice, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { checkInContext } from "@/server/services/frontoffice";
import { settingsFor } from "@/server/services/settings";
import { getCtx } from "@/server/session";
import { withTenant } from "@/server/db/withTenant";
import { PrintButton } from "../../../PrintButton";

/** Printable registration confirmation shown after check-in. Shows only a masked ID. */
export default async function RegistrationConfirmation({ params }: PageProps<"/app/check-in/[id]/confirmation">) {
  const { id } = await params;
  const ctx = await getCtx();
  const c = await checkInContext(getDb(), ctx, id);
  const prop = await withTenant(getDb(), ctx.tenantId, (tx) => tx.property.findFirstOrThrow({ where: { id: ctx.propertyId! }, select: { name: true, legalName: true, address: true, checkOutTime: true } }));
  const st = await settingsFor(getDb(), ctx);
  const r = c.reservation;
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-3 space-y-2 print:hidden">
        <PageHeader title="Checked in" subtitle="Hand or share the registration confirmation with the guest." />
        <Notice tone="success">{c.guest.name} is checked in{c.room ? ` to room ${c.room.number}` : ""}.</Notice>
        <div className="flex flex-wrap items-center gap-3"><PrintButton /><Link className="text-sm underline" href={`/app/reservations/${r.id}`}>View reservation</Link><Link className="text-sm underline" href="/app/operations">Back to today&apos;s operations</Link></div>
      </div>
      <article className="rounded-lg border border-slate-200 bg-white p-6 text-sm shadow-sm print:border-0 print:shadow-none">
        <header className="flex flex-wrap justify-between gap-3">
          <div><h1 className="text-xl font-semibold">Registration confirmation</h1><p className="font-mono">{r.reference}</p></div>
          <div className="text-right"><p className="font-semibold">{prop.legalName ?? prop.name}</p>{prop.address && <p>{prop.address}</p>}</div>
        </header>
        <dl className="mt-4 grid grid-cols-[9rem_1fr] gap-y-1.5">
          <dt className="text-slate-500">Guest</dt><dd>{c.guest.name}</dd>
          <dt className="text-slate-500">Room</dt><dd>{c.room ? `${c.room.number} (${c.room.type})` : "—"}</dd>
          <dt className="text-slate-500">Stay</dt><dd>{fmtDate(new Date(r.arrival))} to {fmtDate(new Date(r.departure))}</dd>
          <dt className="text-slate-500">Guests</dt><dd>{r.adults} adult(s), {r.children} child(ren)</dd>
          <dt className="text-slate-500">Checkout time</dt><dd>{prop.checkOutTime}</dd>
          <dt className="text-slate-500">ID on file</dt><dd>{c.guest.idRecorded ? `${(c.guest.idType ?? "ID").replaceAll("_", " ").toLowerCase()}, number not shown` : "Not recorded"}</dd>
        </dl>
        {st["general.bookingPolicies"] && <p className="mt-4 whitespace-pre-wrap text-xs text-slate-600">{st["general.bookingPolicies"]}</p>}
        <p className="mt-6 border-t pt-1 text-xs text-slate-500">Guest signature</p>
      </article>
    </div>
  );
}
