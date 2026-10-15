import Link from "next/link";
import { ErrorBanner, fmtDate, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { SOURCE_LABELS } from "@/server/domain/quote";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { bookingConfirmation } from "@/server/services/booking";
import { settingsFor } from "@/server/services/settings";
import { roleHasPermission } from "@/server/auth/permissions";
import { getConsent, messagingStatus } from "@/server/services/messaging";
import ReservationMessages from "../../../messages/ReservationMessages";
import { PrintButton } from "../../../PrintButton";

export default async function Confirmation({ params, searchParams }: PageProps<"/app/reservations/[id]/confirmation">) {
  const { id } = await params;
  const { advanceError } = await searchParams;
  const ctx = await getCtx();
  const { property, group, totalMinor, paidMinor, balanceMinor } = await bookingConfirmation(getDb(), ctx, id);
  const first = group[0];
  const canMessage = roleHasPermission(ctx.role, "guests.manage", ctx.extra);
  const consent = canMessage ? await getConsent(getDb(), ctx, first.guestId) : null;
  const st = await settingsFor(getDb(), ctx);
  const depositMinor = Math.floor((totalMinor * st["reservation.depositPercent"] + 50) / 100);
  const policies = [["Booking policies", st["general.bookingPolicies"]], ["Cancellation", st["reservation.cancellationPolicy"]], ["No-show", st["reservation.noShowRule"]], ["Children", st["reservation.childPolicy"]]].filter(([, v]) => v);
  const nights = Math.round((first.departure.getTime() - first.arrival.getTime()) / 86_400_000);
  const guests = group.reduce((t, g) => ({ adults: t.adults + g.adults, children: t.children + g.children }), { adults: 0, children: 0 });
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-3 space-y-2 print:hidden">
        <PageHeader title="Booking saved" subtitle="Share the confirmation below with the guest." />
        {typeof advanceError === "string" && (
          <ErrorBanner message={`The booking is saved, but the advance payment was not recorded: ${advanceError} Record it from the folio.`} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <PrintButton />
          <a href={`/app/reservations/${first.id}/confirmation/pdf`} className="text-sm underline">Download PDF</a>
          <Link href={`/app/reservations/${first.id}`} className="text-sm underline">View reservation</Link>
          <Link href="/app/reservations/new" className="text-sm underline">New booking</Link>
          <Link href="/app/dashboard" className="text-sm underline">Room board</Link>
        </div>
      </div>
      {canMessage && (
        <div className="mb-3 print:hidden">
          <ReservationMessages reservationId={first.id} guestId={first.guestId} back={`/app/reservations/${first.id}/confirmation`} consent={consent ? { status: consent.status, source: consent.source } : null} hasPhone={!!first.guest.phone} testMode={!messagingStatus().configured} />
          <p className="mt-1 text-xs text-slate-600">Messages go out only with the guest&rsquo;s consent and are marked sent only when the provider confirms. Email delivery is not set up for this system; use the PDF to email it yourself.</p>
        </div>
      )}
      <article className="rounded-lg border border-slate-200 bg-white p-6 text-sm shadow-sm print:border-0 print:shadow-none">
        <header className="flex flex-wrap justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Booking confirmation</h1>
            {first.status === "TENTATIVE" && <p className="font-medium text-amber-800">Pending: room held, not yet confirmed.</p>}
            {group.map((g) => <p key={g.id} className="font-mono">{g.reference}</p>)}
            {first.groupRef && <p className="text-xs text-slate-500">Group {first.groupRef}</p>}
          </div>
          <div className="text-right">
            <p className="font-semibold">{property.legalName ?? property.name}</p>
            {property.address && <p>{property.address}</p>}
            {property.gstin && <p>GSTIN: {property.gstin}</p>}
          </div>
        </header>
        {st["reservation.confirmationHeader"] && <p className="mt-4 whitespace-pre-wrap">{st["reservation.confirmationHeader"]}</p>}
        <section className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1">
          <p className="text-slate-500">Guest</p><p>{first.guest.name}{first.guest.phone ? ` · ${first.guest.phone}` : ""}</p>
          <p className="text-slate-500">Check-in</p><p>{fmtDate(first.arrival)} from {property.checkInTime}</p>
          <p className="text-slate-500">Check-out</p><p>{fmtDate(first.departure)} by {property.checkOutTime}</p>
          <p className="text-slate-500">Nights</p><p>{nights}</p>
          <p className="text-slate-500">Guests</p><p>{guests.adults} adult(s), {guests.children} child(ren)</p>
          <p className="text-slate-500">Source</p><p>{SOURCE_LABELS[first.source] ?? first.source}</p>
          {first.companyName && (<><p className="text-slate-500">Company</p><p>{first.companyName}</p></>)}
          {first.notes && (<><p className="text-slate-500">Requests</p><p>{first.notes}</p></>)}
        </section>
        <table className="mt-4 w-full text-left">
          <thead className="border-b text-xs text-slate-500"><tr><th className="py-1">Room</th><th>Type</th><th className="text-right">Rate / night</th></tr></thead>
          <tbody className="divide-y">
            {group.map((g) => (
              <tr key={g.id}>
                <td className="py-1.5">{g.assignments[0]?.room.number ?? "To be assigned"}</td>
                <td>{g.assignments[0]?.room.roomType.name}</td>
                <td className="text-right font-mono">{formatInr(g.agreedRateMinor ?? g.assignments[0]?.room.roomType.baseRateMinor ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-4 ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-y-1">
          <dt>Estimated total</dt><dd className="text-right font-mono">{formatInr(totalMinor)}</dd>
          {paidMinor !== null && (<><dt>Advance received</dt><dd className="text-right font-mono">{formatInr(paidMinor)}</dd></>)}
          {balanceMinor !== null && (<><dt className="font-semibold">Balance at stay</dt><dd className="text-right font-mono font-semibold">{formatInr(balanceMinor)}</dd></>)}
        </dl>
        {depositMinor > 0 && (
          <p className="mt-3 text-sm"><strong>Deposit requested:</strong> {formatInr(depositMinor)} ({st["reservation.depositPercent"]}% of the estimate){paidMinor !== null && paidMinor >= depositMinor ? " — received." : "."}</p>
        )}
        {policies.length > 0 && (
          <div className="mt-4 space-y-2 text-xs text-slate-700">
            {policies.map(([k, v]) => <p key={k} className="whitespace-pre-wrap"><strong>{k}:</strong> {v}</p>)}
          </div>
        )}
        {st["reservation.confirmationFooter"] && <p className="mt-4 whitespace-pre-wrap">{st["reservation.confirmationFooter"]}</p>}
        <p className="mt-4 text-xs text-slate-500">
          Estimated amounts include GST where applicable and exclude extras. The final bill is issued at check-out. Please carry a valid photo ID.
        </p>
      </article>
    </div>
  );
}
