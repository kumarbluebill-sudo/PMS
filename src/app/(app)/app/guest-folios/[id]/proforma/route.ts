import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { resolveInvoiceStyle } from "@/server/domain/invoiceTheme";
import { renderInvoicePdf } from "@/server/pdf/invoice";
import { getCtx } from "@/server/session";
import { folioDetail } from "@/server/services/billing";
import { fetchLogo } from "@/server/services/confirmationDoc";
import { previewInvoice } from "@/server/services/invoicing";
import { settingsFor } from "@/server/services/settings";

type Party = { name?: string; gstin?: string | null; stateCode?: string | null; address?: string | null; registered?: boolean };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A pro forma invoice: what the invoice would say for the charges posted so far. It is not numbered in the tax invoice
 * series, is not saved as an invoice, and says clearly that it is not a tax invoice. Needs the right to issue invoices.
 */
export async function GET(_req: NextRequest, { params }: RouteContext<"/app/guest-folios/[id]/proforma">) {
  const { id } = await params;
  const ctx = await getCtx();
  const [d, p, st] = await Promise.all([folioDetail(getDb(), ctx, id), previewInvoice(getDb(), ctx, id, {}), settingsFor(getDb(), ctx)]);
  const r = d.folio.reservation;
  const today = iso(new Date());
  const bytes = await renderInvoicePdf({
    number: `PRO-FORMA/${r.reference}/${today.replaceAll("-", "")}`, kind: "PRO_FORMA", issuedDate: today,
    notice: "Not a tax invoice. Amounts are subject to the final bill.",
    supplier: p.supplier as Party, recipient: p.recipient as Party,
    terms: st["billing.invoiceTerms"], footerNote: st["billing.invoiceNotes"], headerLine: st["billing.docHeader"], paymentInstructions: st["billing.paymentInstructions"],
    style: resolveInvoiceStyle({ theme: st["billing.theme"], accent: st["billing.accentColor"], font: st["billing.font"] }),
    logo: await fetchLogo(d.property?.logoUrl || st["general.logoUrl"]),
    stay: { reference: r.reference, source: r.source, arrival: iso(r.arrival), departure: iso(r.departure), nights: Math.max(1, Math.round((r.departure.getTime() - r.arrival.getTime()) / 86_400_000)) },
    lines: p.lines.map((l) => ({ description: l.description, sacCode: l.sacCode, netMinor: l.netMinor, cgstMinor: l.cgstMinor, sgstMinor: l.sgstMinor, igstMinor: l.igstMinor, cessMinor: l.cessMinor, grossMinor: l.grossMinor })),
    totals: { netMinor: p.totals.net, cgstMinor: p.totals.cgst, sgstMinor: p.totals.sgst, igstMinor: p.totals.igst, cessMinor: p.totals.cess, grossMinor: p.totals.gross },
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="pro-forma-${r.reference.replace(/[^\w.-]/g, "-")}.pdf"`, "cache-control": "private, no-store" },
  });
}
