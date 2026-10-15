import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { GST_STATES } from "@/server/domain/gst";
import { resolveInvoiceStyle } from "@/server/domain/invoiceTheme";
import { renderInvoicePdf } from "@/server/pdf/invoice";
import { getCtx } from "@/server/session";
import { getInvoice } from "@/server/services/invoicing";
import { settingsFor } from "@/server/services/settings";

type Party = { name?: string; gstin?: string | null; stateCode?: string | null; address?: string | null; registered?: boolean };

/** Server-generated PDF of an issued document (billing access required). */
export async function GET(_req: NextRequest, { params }: RouteContext<"/app/invoices/[id]/pdf">) {
  const { id } = await params;
  const ctx = await getCtx();
  const inv = await getInvoice(getDb(), ctx, id);
  const st = await settingsFor(getDb(), ctx);
  const bytes = await renderInvoicePdf({
    number: inv.number, kind: inv.kind, issuedDate: inv.issuedDate, originalNumber: inv.originalNumber, reason: inv.reason,
    supplier: inv.supplier as Party, recipient: inv.recipient as Party,
    placeOfSupply: inv.placeOfSupply, placeOfSupplyName: inv.placeOfSupply ? (GST_STATES[inv.placeOfSupply] ?? null) : null,
    terms: st["billing.invoiceTerms"], footerNote: st["billing.invoiceNotes"],
    headerLine: st["billing.docHeader"], paymentInstructions: st["billing.paymentInstructions"], signatureLabel: st["billing.signatureLabel"],
    style: resolveInvoiceStyle({ theme: st["billing.theme"], accent: st["billing.accentColor"], font: st["billing.font"] }),
    lines: inv.lines.map((l) => ({
      description: l.description, sacCode: l.sacCode, netMinor: l.netMinor, cgstMinor: l.cgstMinor, sgstMinor: l.sgstMinor,
      igstMinor: l.igstMinor, cessMinor: l.cessMinor, grossMinor: l.grossMinor,
    })),
    totals: { netMinor: inv.netMinor, cgstMinor: inv.cgstMinor, sgstMinor: inv.sgstMinor, igstMinor: inv.igstMinor, cessMinor: inv.cessMinor, grossMinor: inv.grossMinor },
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${inv.number.replace(/[^\w.\-]/g, "-")}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
