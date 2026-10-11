import Link from "next/link";
import { fmtDate } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { formatInr } from "@/server/money";
import { getCtx } from "@/server/session";
import { getPaymentReceipt } from "@/server/services/payments";
import { settingsFor } from "@/server/services/settings";
import { PrintButton } from "../../../PrintButton";

export default async function Receipt({ params }: PageProps<"/app/payments/[id]/receipt">) {
  const { id } = await params;
  const ctx = await getCtx();
  const { payment, property, balanceAfterMinor, receivedByName } = await getPaymentReceipt(getDb(), ctx, id);
  const res = payment.folio.reservation;
  const st = await settingsFor(getDb(), ctx);
  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-3 flex items-center justify-between print:hidden">
        <Link className="text-sm underline" href={`/app/guest-folios/${payment.folioId}`}>Back to folio</Link>
        <PrintButton />
      </div>
      <article className="rounded-lg border border-slate-200 bg-white p-6 text-sm shadow-sm print:border-0 print:shadow-none">
        <header className="flex flex-wrap justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Payment receipt</h1>
            <p className="font-mono text-xs">{payment.id.slice(0, 8).toUpperCase()}</p>
            <p>Date: {fmtDate(payment.receivedAt)}</p>
          </div>
          <div className="text-right">
            <p className="font-semibold">{property.legalName ?? property.name}</p>
            {property.address && <p>{property.address}</p>}
            {property.gstin && <p>GSTIN: {property.gstin}</p>}
          </div>
        </header>
        <dl className="mt-4 grid grid-cols-[9rem_1fr] gap-y-1">
          <dt className="text-slate-500">Received from</dt><dd>{res.guest.name}</dd>
          <dt className="text-slate-500">Booking</dt><dd className="font-mono">{res.reference}</dd>
          <dt className="text-slate-500">Stay</dt><dd>{fmtDate(res.arrival)} → {fmtDate(res.departure)}</dd>
          <dt className="text-slate-500">Method</dt><dd>{payment.method.replace("_", " ").toLowerCase()}</dd>
          {payment.reference && (<><dt className="text-slate-500">Reference</dt><dd>{payment.reference}</dd></>)}
          <dt className="text-slate-500">Received by</dt><dd>{receivedByName}</dd>
        </dl>
        <p className="mt-4 text-2xl font-semibold">{formatInr(payment.amountMinor)}</p>
        <p className="mt-1 text-slate-600">Balance on the folio after this payment: {formatInr(balanceAfterMinor)}</p>
        <p className="mt-4 text-xs text-slate-500">This receipt acknowledges money received. It is not a tax invoice.</p>
        {st["billing.receiptFooter"] && <p className="mt-2 whitespace-pre-wrap text-xs text-slate-600">{st["billing.receiptFooter"]}</p>}
      </article>
    </div>
  );
}
