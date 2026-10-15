import Link from "next/link";
import { Badge, btn, btnGhost, Card, Notice, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { roleHasPermission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { folioDetail } from "@/server/services/billing";
import { checkoutOverview } from "@/server/services/checkout";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** What happened at check-out and the documents from it: invoice, a receipt per payment, and next steps. */
export default async function CheckoutDone({ params, searchParams }: PageProps<"/app/reservations/[id]/checkout/done">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const o = await checkoutOverview(db, ctx, id);
  const r = o.reservation;
  if (r.status !== "CHECKED_OUT") {
    return <p className="text-sm">This stay has not been checked out. <Link className="underline" href={`/app/reservations/${id}/checkout`}>Go to check-out</Link></p>;
  }
  const d = o.folioId && can("billing.view") ? await folioDetail(db, ctx, o.folioId) : null;
  const payments = d?.folio.entries.filter((e) => e.kind === "PAYMENT" && e.paymentId) ?? [];
  const invoices = d?.folio.invoices ?? [];

  return (
    <>
      <Breadcrumbs items={[{ label: "Today's operations", href: "/app/operations" }, { label: `Check-out ${r.reference}` }]} />
      <PageHeader title="Check-out complete" subtitle={`${r.guest.name} · ${r.reference}${o.roomNumber ? ` · room ${o.roomNumber}` : ""}`} />
      {one(sp.dup) && <Notice tone="warn">This check-out had already been completed, so nothing was changed and no payment was taken again.</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Summary">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-600">Reservation</dt><dd><Badge value="CHECKED_OUT" /></dd>
            <dt className="text-slate-600">Left at</dt><dd>{r.actualDeparture ? `${r.actualDeparture.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Not recorded"}</dd>
            <dt className="text-slate-600">Room</dt><dd>{o.roomNumber ?? "-"}: Vacant, dirty. Housekeeping has been notified.</dd>
            {d && (<><dt className="text-slate-600">Total billed</dt><dd>{formatInr(d.billed)}</dd><dt className="text-slate-600">Paid</dt><dd>{formatInr(d.paid)}</dd>
              <dt className="text-slate-600">Balance</dt><dd className={d.balance > 0 ? "font-medium text-amber-900" : ""}>{formatInr(d.balance)}{d.balance > 0 ? " (approved unpaid; recorded in the audit log)" : ""}</dd></>)}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/app/housekeeping" className={btnGhost}>Open housekeeping</Link>
            <Link href={`/app/reservations/${id}`} className={btnGhost}>Reservation</Link>
            <Link href="/app/operations" className={btn}>Back to operations</Link>
          </div>
        </Card>
        <Card title="Documents">
          {!d ? <p className="text-sm text-slate-700">You do not have access to billing documents.</p> : (
            <div className="space-y-3 text-sm">
              <div>
                <h3 className="font-medium">Invoices</h3>
                {invoices.length === 0 ? <p className="text-slate-700">No invoice was issued at check-out.</p> : (
                  <ul className="space-y-1">{invoices.map((i) => (
                    <li key={i.id}><Link className="underline" href={`/app/invoices/${i.id}`}>{i.number}</Link> <span className="text-slate-600">{i.kind.replace("_", " ").toLowerCase()}</span> · <a className="underline" href={`/app/invoices/${i.id}/pdf`}>PDF</a></li>
                  ))}</ul>
                )}
              </div>
              <div>
                <h3 className="font-medium">Receipts</h3>
                {payments.length === 0 ? <p className="text-slate-700">No payment was recorded.</p> : (
                  <ul className="space-y-1">{payments.map((p) => (
                    <li key={p.id}>{d.paymentRefs.get(p.paymentId!) ?? "payment"} · {formatInr(-p.balanceDeltaMinor)} · <Link className="underline" href={`/app/payments/${p.paymentId}/receipt`}>Receipt</Link> · <a className="underline" href={`/app/payments/${p.paymentId}/pdf`}>PDF</a></li>
                  ))}</ul>
                )}
              </div>
              {d.folio.id && <p><a className="underline" href={`/app/guest-folios/${d.folio.id}/statement`}>Download the folio statement (PDF)</a></p>}
              <p className="text-xs text-slate-600">To send documents to the guest, use the WhatsApp section on the <Link className="underline" href={`/app/reservations/${id}`}>reservation page</Link>; it respects the guest&rsquo;s consent and shows the real delivery status.</p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
