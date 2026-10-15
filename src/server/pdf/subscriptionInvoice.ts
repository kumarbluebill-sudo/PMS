import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { pdfMoney, pdfSafe } from "./invoice";

export type PdfSubscriptionInvoice = {
  number: string;
  issuedDate: string;
  dueDate: string;
  status: string;
  seller: { name: string; gstin: string; address: string; sacCode: string };
  customer: string;
  lines: { description: string; amountMinor: number }[];
  netMinor: number;
  taxBps: number;
  taxMinor: number;
  grossMinor: number;
  paidMinor: number;
  paymentInstructions: string;
};

/**
 * The software provider's invoice to a hotel for its subscription. It is separate from guest invoices: its own numbers
 * (MKS series), its own tax details. The provider's accountant decides the SAC code and rate in the platform settings.
 */
export async function renderSubscriptionInvoicePdf(inv: PdfSubscriptionInvoice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  const M = 44, W = 595;
  const ink = rgb(0.1, 0.1, 0.1), accent = rgb(0.04, 0.24, 0.23), grey = rgb(0.45, 0.45, 0.45), light = rgb(0.8, 0.8, 0.8);
  let y = 842 - M;
  const put = (t: string, x: number, yy: number, f: PDFFont = font, size = 9.5, color = ink) => page.drawText(pdfSafe(t), { x, y: yy, size, font: f, color });
  const right = (t: string, xr: number, yy: number, f: PDFFont = font, size = 9.5) => {
    const v = pdfSafe(t);
    page.drawText(v, { x: xr - f.widthOfTextAtSize(v, size), y: yy, size, font: f, color: ink });
  };
  const wrapText = (text: string, f: PDFFont, size: number, width: number) => {
    const out: string[] = [];
    for (const para of pdfSafe(text).split("\n")) {
      let line = "";
      for (const w of para.split(/\s+/)) {
        const next = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(next, size) <= width || !line) line = next;
        else { out.push(line); line = w; }
      }
      out.push(line);
    }
    return out;
  };

  put(inv.status === "PAID" ? "Tax invoice (paid)" : "Tax invoice", M, y - 14, bold, 18, accent);
  put(inv.number, M, y - 32, bold, 11, accent);
  put(`Date: ${inv.issuedDate}`, M, y - 46);
  put(`Due: ${inv.dueDate}`, M, y - 59);
  let ry = y - 14;
  const sellerLines = [inv.seller.name, ...(inv.seller.address ? wrapText(inv.seller.address, font, 9, 230) : []), ...(inv.seller.gstin ? [`GSTIN: ${inv.seller.gstin}`] : [])];
  sellerLines.forEach((l, i) => {
    right(l, W - M, ry, i === 0 ? bold : font, i === 0 ? 12 : 9);
    ry -= 12;
  });
  y = Math.min(y - 72, ry) - 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: light });
  y -= 18;
  put("Billed to", M, y, font, 8.5, grey);
  y -= 14;
  put(inv.customer, M, y, bold, 11);
  y -= 30;

  put("Description", M, y, bold, 9);
  right("Amount", W - M, y, bold, 9);
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: light });
  y -= 14;
  for (const l of inv.lines) {
    const lines = wrapText(l.description, font, 9.5, W - 2 * M - 110);
    lines.forEach((t, i) => put(t, M, y - i * 12));
    right(pdfMoney(l.amountMinor), W - M, y);
    y -= lines.length * 12 + 6;
  }
  y -= 4;
  page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.5, color: light });
  const row = (label: string, v: number, strong = false) => {
    put(label, W - M - 220, y, strong ? bold : font, strong ? 11 : 9.5);
    right(pdfMoney(v), W - M, y, strong ? bold : font, strong ? 11 : 9.5);
    y -= strong ? 18 : 14;
  };
  row("Amount before tax", inv.netMinor);
  row(`GST at ${(inv.taxBps / 100).toFixed(inv.taxBps % 100 === 0 ? 0 : 2)}%`, inv.taxMinor);
  row("Total", inv.grossMinor, true);
  if (inv.paidMinor > 0) row("Received", inv.paidMinor);
  if (inv.grossMinor - inv.paidMinor > 0) row("Balance due", inv.grossMinor - inv.paidMinor, true);
  if (inv.seller.sacCode) { y -= 4; put(`SAC ${inv.seller.sacCode}`, M, y, font, 8.5, grey); y -= 14; }
  if (inv.paymentInstructions && inv.status !== "PAID") {
    y -= 10;
    put("How to pay", M, y, bold, 9.5);
    y -= 13;
    for (const t of wrapText(inv.paymentInstructions, font, 9, W - 2 * M)) { put(t, M, y, font, 9); y -= 11.5; }
  }
  put("Computer generated invoice. Subscription fees are billed separately from any bills your hotel issues to guests.", M, 28, font, 7.5, grey);
  doc.setTitle(pdfSafe(`Invoice ${inv.number}`));
  doc.setCreator("MK Hotel PMS");
  return doc.save();
}
