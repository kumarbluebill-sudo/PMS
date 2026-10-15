import { NextResponse, type NextRequest } from "next/server";
import { authorize } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { resolveInvoiceStyle } from "@/server/domain/invoiceTheme";
import { renderInvoicePdf, type PdfLine } from "@/server/pdf/invoice";
import { getCtx } from "@/server/session";
import { settingsFor } from "@/server/services/settings";

/** Sample figures only. This route never reads a real guest, folio or invoice. */
const LINES: PdfLine[] = [
  { description: "Deluxe room, 2 nights", sacCode: "996311", netMinor: 800_000, cgstMinor: 48_000, sgstMinor: 48_000, igstMinor: 0, cessMinor: 0, grossMinor: 896_000 },
  { description: "Restaurant: dinner", sacCode: "996331", netMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250, igstMinor: 0, cessMinor: 0, grossMinor: 52_500 },
];

export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  authorize(ctx, "settings.view");
  const q = req.nextUrl.searchParams;
  const st = await settingsFor(getDb(), ctx);
  const sum = (k: keyof PdfLine) => LINES.reduce((s, l) => s + (l[k] as number), 0);
  const bytes = await renderInvoicePdf({
    number: "SAMPLE/0001", kind: "TAX_INVOICE", issuedDate: new Date().toISOString().slice(0, 10),
    reason: "Preview with sample data. Not a real document.",
    supplier: { name: "Sample Hotel", address: "12 Example Road, Sample City", gstin: "29ABCDE1234F1Z5", registered: true },
    recipient: { name: "Sample Guest", address: "Example Street, Sample City" },
    placeOfSupply: "29", placeOfSupplyName: "Karnataka",
    terms: st["billing.invoiceTerms"], footerNote: st["billing.invoiceNotes"], headerLine: st["billing.docHeader"],
    paymentInstructions: st["billing.paymentInstructions"], signatureLabel: st["billing.signatureLabel"],
    style: resolveInvoiceStyle({ theme: q.get("theme") ?? st["billing.theme"], accent: q.get("accent") ?? st["billing.accentColor"], font: q.get("font") ?? st["billing.font"] }),
    lines: LINES,
    totals: { netMinor: sum("netMinor"), cgstMinor: sum("cgstMinor"), sgstMinor: sum("sgstMinor"), igstMinor: 0, cessMinor: 0, grossMinor: sum("grossMinor") },
  });
  return new NextResponse(Buffer.from(bytes), { headers: { "content-type": "application/pdf", "content-disposition": "inline; filename=\"sample-invoice.pdf\"", "cache-control": "private, no-store" } });
}
