import { NextResponse, type NextRequest } from "next/server";
import { fmtDate } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { isAdvance, renderReceiptPdf } from "@/server/pdf/receipt";
import { getCtx } from "@/server/session";
import { getPaymentReceipt } from "@/server/services/payments";
import { settingsFor } from "@/server/services/settings";

/** Server-generated receipt PDF (billing access and tenant checks happen in getPaymentReceipt). */
export async function GET(_req: NextRequest, { params }: RouteContext<"/app/payments/[id]/pdf">) {
  const { id } = await params;
  const ctx = await getCtx();
  const { payment, property, balanceAfterMinor, receivedByName } = await getPaymentReceipt(getDb(), ctx, id);
  const st = await settingsFor(getDb(), ctx);
  const res = payment.folio.reservation;
  const bytes = await renderReceiptPdf({
    id: payment.id,
    advance: isAdvance(res.status, payment.receivedAt, res.arrival),
    date: fmtDate(payment.receivedAt),
    hotel: { name: property.legalName ?? property.name, address: property.address, gstin: property.gstin },
    headerLine: st["billing.docHeader"],
    guest: res.guest.name,
    reference: res.reference,
    stay: `${fmtDate(res.arrival)} to ${fmtDate(res.departure)}`,
    method: payment.method.replaceAll("_", " ").toLowerCase(),
    paymentRef: payment.reference,
    receivedBy: receivedByName,
    amountMinor: payment.amountMinor,
    balanceAfterMinor,
    footer: st["billing.receiptFooter"],
    signatureLabel: st["billing.signatureLabel"],
    layout: st["billing.receiptLayout"],
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="receipt-${payment.id.slice(0, 8)}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
