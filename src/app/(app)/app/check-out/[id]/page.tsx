import Link from "next/link";
import { Badge, btn, btnGhost, Card, inr, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { checkoutSummary } from "@/server/services/frontoffice";
import { getCtx } from "@/server/session";

/** Money picture for a departing guest. Collecting payment and completing checkout reuse the existing folio and settlement flows. */
export default async function CheckOutControl({ params }: PageProps<"/app/check-out/[id]">) {
  const { id } = await params;
  const ctx = await getCtx();
  const s = await checkoutSummary(getDb(), ctx, id);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const rows: [string, number, string?][] = [
    ["Room charges (incl. tax)", s.roomCharges, s.unpostedNights > 0 ? `${s.unpostedNights} night(s) are posted when you check out` : undefined],
    ["Service charges (incl. tax)", s.serviceCharges],
    ["Discounts and adjustments", s.adjustments],
    ["Advance and payments received", -s.paid],
    ["Refunds", s.refunded],
  ];
  const done = s.status === "CHECKED_OUT";
  return (
    <>
      <Breadcrumbs items={[{ label: "Today's operations", href: "/app/operations" }, { label: `Checkout ${s.reference}` }]} />
      <PageHeader title={`Checkout: ${s.guest}`} subtitle={`${s.reference}${s.room ? ` · room ${s.room}` : ""} · expected ${s.expectedCheckout}`} actions={<Badge value={s.status} />} />
      {s.overdue && <p role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">This guest was due out on {s.departure} and is still in house.</p>}
      {s.lateCheckoutRequest && <Notice tone="info">Late checkout requested: {s.lateCheckoutRequest}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Folio summary">
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {rows.map(([label, amt, hint]) => (
                <tr key={label}><th scope="row" className="text-left font-normal text-slate-700">{label}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</th><td className="text-right tabular-nums">{inr(amt)}</td></tr>
              ))}
              <tr><th scope="row" className="text-left font-semibold">Outstanding balance</th><td className={`text-right text-base font-semibold tabular-nums ${s.balance > 0 ? "text-red-700" : "text-green-800"}`}>{inr(s.balance)}</td></tr>
            </tbody>
          </table>
          {s.balance > 0 && !done && <p className="mt-2 text-xs text-amber-900">A balance cannot be dropped silently: collect payment, or a manager records an approved exception with a reason on the next screen.</p>}
        </Card>
        <Card title="Invoices">
          {s.invoices.length === 0 ? <p className="text-sm text-slate-600">No invoice has been issued yet. It is issued as part of checkout, or from the folio.</p> : (
            <ul className="divide-y text-sm">
              {s.invoices.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 py-1.5"><Link className="underline" href={`/app/invoices/${i.id}`}>{i.number}</Link><span className="text-xs text-slate-500">{i.kind.replaceAll("_", " ").toLowerCase()} · {i.issuedAt}</span><span className="tabular-nums">{inr(i.grossMinor)}</span></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {!done && s.status === "CHECKED_IN" && (
        <Card title="Actions">
          <div className="flex flex-wrap gap-2">
            {s.folioId && <Link href={`/app/guest-folios/${s.folioId}`} className={btnGhost}>Open guest folio</Link>}
            {s.folioId && can("billing.post") && <Link href={`/app/guest-folios/${s.folioId}#charge`} className={btnGhost}>Add a service charge</Link>}
            {s.folioId && can("payments.record") && <Link href={`/app/guest-folios/${s.folioId}#payment`} className={btnGhost}>Record payment</Link>}
            {can("frontdesk.checkout") && <Link href={`/app/reservations/${s.id}/checkout`} className={btn}>Settle and check out</Link>}
          </div>
          <p className="mt-2 text-xs text-slate-500">Checkout leaves the room dirty and creates a housekeeping task for cleaning.</p>
        </Card>
      )}
      {done && <Notice tone="success">This guest has checked out. The room was passed to housekeeping.</Notice>}
    </>
  );
}
