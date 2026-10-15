import { NextResponse, type NextRequest } from "next/server";
import { fmtDate } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { resolveInvoiceStyle } from "@/server/domain/invoiceTheme";
import { renderStatementPdf } from "@/server/pdf/statement";
import { getCtx } from "@/server/session";
import { folioDetail } from "@/server/services/billing";
import { settingsFor } from "@/server/services/settings";

/** Folio statement PDF: the account of a stay, including payments. Needs billing access (checked in folioDetail). */
export async function GET(_req: NextRequest, { params }: RouteContext<"/app/guest-folios/[id]/statement">) {
  const { id } = await params;
  const ctx = await getCtx();
  const d = await folioDetail(getDb(), ctx, id);
  const st = await settingsFor(getDb(), ctx);
  const f = d.folio;
  const res = f.reservation;
  const bytes = await renderStatementPdf({
    hotel: { name: d.property?.legalName ?? d.property?.name ?? "Hotel", address: d.property?.address, gstin: d.property?.gstin },
    headerLine: st["billing.docHeader"],
    guest: res.guest.name, reservation: res.reference, stay: `${fmtDate(res.arrival)} to ${fmtDate(res.departure)}`,
    asOf: fmtDate(new Date()), billTo: f.label === "COMPANY" ? f.billTo : null,
    rows: f.entries.map((e) => ({
      date: fmtDate(e.serviceDate ?? e.postedAt),
      description: `${e.description}${e.kind === "CHARGE" || e.kind === "PAYMENT" ? "" : ` (${e.kind.toLowerCase()})`}`,
      kind: e.kind, quantity: e.kind === "CHARGE" ? e.quantity : null, taxableMinor: e.kind === "PAYMENT" ? 0 : e.netMinor, taxMinor: e.taxMinor,
      amountMinor: e.balanceDeltaMinor, reference: e.paymentId ? (d.paymentRefs.get(e.paymentId) ?? "") : "",
    })),
    summary: { billedMinor: d.billed, paidMinor: d.paid, refundedMinor: d.refunded, balanceMinor: d.balance },
    style: resolveInvoiceStyle({ theme: st["billing.theme"], accent: st["billing.accentColor"], font: st["billing.font"] }),
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="folio-${res.reference.replace(/[^\w.-]/g, "-")}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
