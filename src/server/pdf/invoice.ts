import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { resolveInvoiceStyle, type InvoiceFont, type InvoiceStyle } from "@/server/domain/invoiceTheme";

type Party = { name?: string; gstin?: string | null; stateCode?: string | null; address?: string | null; registered?: boolean };
export type PdfLine = {
  description: string; sacCode: string | null; netMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; cessMinor: number; grossMinor: number;
};
export type PdfInvoice = {
  number: string;
  kind: string;
  issuedDate: string;
  originalNumber?: string | null;
  reason?: string | null;
  supplier: Party;
  recipient: Party;
  placeOfSupply?: string | null;
  placeOfSupplyName?: string | null;
  /** From the hotel's billing settings. */
  terms?: string | null;
  footerNote?: string | null;
  headerLine?: string | null;
  paymentInstructions?: string | null;
  signatureLabel?: string | null;
  /** Colours, type and spacing only. Defaults to the classic theme. */
  style?: InvoiceStyle;
  /** Printed at the top right, e.g. ORIGINAL FOR RECIPIENT or DUPLICATE COPY (2). */
  copyLabel?: string | null;
  /** A line under the title, e.g. "Not a tax invoice" on a pro forma. */
  notice?: string | null;
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null;
  /** The stay this document is for. */
  stay?: { reference: string; source?: string | null; room?: string | null; category?: string | null; arrival: string; departure: string; nights: number } | null;
  lines: PdfLine[];
  totals: { netMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; cessMinor: number; grossMinor: number };
};

const TITLES: Record<string, string> = { TAX_INVOICE: "Tax Invoice", BILL_OF_SUPPLY: "Bill of Supply", CREDIT_NOTE: "Credit Note", DEBIT_NOTE: "Debit Note", PRO_FORMA: "Pro Forma Invoice" };

/** The standard PDF fonts only cover Latin-1, so the rupee sign is written as "Rs." and anything else outside is replaced. */
export const pdfSafe = (s: string) => s.replaceAll("₹", "Rs.").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

/** Rupees with Indian digit grouping and two decimals, e.g. Rs. 1,23,456.00 */
export function pdfMoney(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}Rs. ${Math.floor(abs / 100).toLocaleString("en-IN")}.${String(abs % 100).padStart(2, "0")}`;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of pdfSafe(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) out.push(line);
      line = word;
      // A single very long word is cut rather than overflowing.
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let n = line.length;
        while (n > 1 && font.widthOfTextAtSize(line.slice(0, n), size) > width) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

/** A4 invoice / bill of supply / credit note / debit note drawn from saved, immutable document data. */
const FONTS: Record<InvoiceFont, [StandardFonts, StandardFonts]> = {
  HELVETICA: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  TIMES: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  COURIER: [StandardFonts.Courier, StandardFonts.CourierBold],
};

export async function renderInvoicePdf(inv: PdfInvoice): Promise<Uint8Array> {
  const S = inv.style ?? resolveInvoiceStyle();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(FONTS[S.font][0]);
  const bold = await doc.embedFont(FONTS[S.font][1]);
  const W = 595, H = 842, M = 40, size = S.baseSize;
  const accent = rgb(...S.accent), ruleCol = rgb(...S.rule);
  const showTax = inv.kind !== "BILL_OF_SUPPLY";
  const cols = showTax
    ? [{ k: "d", t: "Description", w: 150 }, { k: "s", t: "SAC", w: 45 }, { k: "n", t: "Taxable", w: 62 }, { k: "c", t: "CGST", w: 52 }, { k: "g", t: "SGST", w: 52 }, { k: "i", t: "IGST", w: 52 }, { k: "x", t: "Cess", w: 40 }, { k: "t", t: "Total", w: 62 }]
    : [{ k: "d", t: "Description", w: 280 }, { k: "s", t: "SAC", w: 55 }, { k: "n", t: "Amount", w: 90 }, { k: "t", t: "Total", w: 90 }];

  let page!: PDFPage;
  let y = 0;
  const pages: PDFPage[] = [];
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    if (S.topBar) page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: ruleCol });
    y = H - M;
  };
  const text = (s: string, x: number, yy: number, f = font, sz = size, color = rgb(0.1, 0.1, 0.1)) => page.drawText(pdfSafe(s), { x, y: yy, size: sz, font: f, color });
  const right = (s: string, xRight: number, yy: number, f = font, sz = size) => {
    const t = pdfSafe(s);
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, sz), y: yy, size: sz, font: f, color: rgb(0.1, 0.1, 0.1) });
  };
  const rule = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: S.topBar ? 0.8 : 0.5, color: ruleCol });

  newPage();
  if (inv.copyLabel) right(inv.copyLabel, W - M, H - 26, bold, 8);
  if (inv.logo) {
    try {
      const img = inv.logo.type === "png" ? await doc.embedPng(inv.logo.bytes) : await doc.embedJpg(inv.logo.bytes);
      const scale = Math.min(44 / img.height, 150 / img.width, 1);
      page.drawImage(img, { x: M, y: y - img.height * scale + 6, width: img.width * scale, height: img.height * scale });
      y -= img.height * scale + 8;
    } catch { /* an unreadable logo is left out */ }
  }
  text(TITLES[inv.kind] ?? inv.kind, M, y - 14, bold, 16, accent);
  text(inv.number, M, y - 30, bold, 11, accent);
  text(`Date: ${inv.issuedDate}`, M, y - 44);
  let ly = y - 58;
  if (inv.notice) { text(inv.notice, M, ly, bold, 8.5, rgb(0.6, 0.15, 0.1)); ly -= 12; }
  if (inv.originalNumber) { text(`Against invoice: ${inv.originalNumber}`, M, ly); ly -= 12; }
  if (inv.reason) for (const l of wrap(`Reason: ${inv.reason}`, font, size, 250)) { text(l, M, ly); ly -= 12; }
  // Supplier on the right.
  let ry = y - 14;
  const sup = [inv.supplier.name ?? "", ...(inv.supplier.address ? wrap(inv.supplier.address, font, size, 230) : []), inv.supplier.gstin ? `GSTIN: ${inv.supplier.gstin}` : "Not registered under GST"];
  if (inv.headerLine) sup.splice(1, 0, inv.headerLine);
  sup.forEach((l, i) => { right(l, W - M, ry, i === 0 ? bold : font, i === 0 ? 11 : size); ry -= 13; });
  y = Math.min(ly, ry) - 10;
  rule(y);
  y -= 16;

  text("Bill to", M, y, font, 8);
  y -= 12;
  text(inv.recipient.name ?? "", M, y, bold, 10);
  y -= 12;
  for (const l of inv.recipient.address ? wrap(inv.recipient.address, font, size, 300) : []) { text(l, M, y); y -= 12; }
  if (inv.recipient.gstin) { text(`GSTIN: ${inv.recipient.gstin}`, M, y); y -= 12; }
  if (inv.placeOfSupply) { text(`Place of supply: ${inv.placeOfSupplyName ?? ""} (${inv.placeOfSupply})`, M, y); y -= 12; }
  if (inv.stay) {
    const st = inv.stay;
    for (const l of wrap(`Reservation ${st.reference}${st.source ? ` · ${st.source}` : ""}${st.room ? ` · Room ${st.room}` : ""}${st.category ? ` (${st.category})` : ""} · Stay ${st.arrival} to ${st.departure} (${st.nights} night${st.nights === 1 ? "" : "s"})`, font, size, W - 2 * M)) { text(l, M, y); y -= 12; }
  }
  y -= 8;

  const header = () => {
    if (S.headFill) page.drawRectangle({ x: M - 3, y: y - 9, width: W - 2 * M + 6, height: 19, color: rgb(...S.headFill) });
    let x = M;
    for (const c of cols) {
      if (c.k === "d" || c.k === "s") text(c.t, x, y, bold, 8);
      else right(c.t, x + c.w, y, bold, 8);
      x += c.w;
    }
    y -= 6;
    rule(y);
    y -= 12;
  };
  header();

  for (const l of inv.lines) {
    const desc = wrap(l.description, font, size, cols[0].w - 6);
    if (y - desc.length * 11 < M + 120) {
      newPage();
      header();
    }
    const vals: Record<string, string> = {
      s: l.sacCode ?? "", n: pdfMoney(l.netMinor), c: pdfMoney(l.cgstMinor), g: pdfMoney(l.sgstMinor), i: pdfMoney(l.igstMinor), x: pdfMoney(l.cessMinor), t: pdfMoney(l.grossMinor),
    };
    let x = M;
    for (const c of cols) {
      if (c.k === "d") desc.forEach((d, i) => text(d, x, y - i * 11));
      else if (c.k === "s") text(vals.s, x, y);
      else right(vals[c.k], x + c.w, y);
      x += c.w;
    }
    y -= Math.max(1, desc.length) * 11 + S.rowGap;
  }
  rule(y + 6);
  y -= 8;

  if (y < M + 110) newPage();
  const t = inv.totals;
  const rows: [string, number][] = showTax
    ? [["Taxable value", t.netMinor], ["CGST", t.cgstMinor], ["SGST", t.sgstMinor], ["IGST", t.igstMinor], ["Cess", t.cessMinor]]
    : [];
  for (const [label, amt] of rows) {
    if (amt === 0 && label !== "Taxable value") continue;
    text(label, W - M - 200, y);
    right(pdfMoney(amt), W - M, y);
    y -= 13;
  }
  text(inv.kind === "CREDIT_NOTE" ? "Total credited" : "Total", W - M - 200, y, bold, 11);
  right(pdfMoney(t.grossMinor), W - M, y, bold, 11);
  y -= 24;
  if (showTax && inv.lines.length > 0) {
    // Tax by SAC code, the summary an accountant looks for.
    const by = new Map<string, { net: number; cgst: number; sgst: number; igst: number }>();
    for (const l of inv.lines) {
      const k = l.sacCode ?? "-";
      const c = by.get(k) ?? { net: 0, cgst: 0, sgst: 0, igst: 0 };
      c.net += l.netMinor; c.cgst += l.cgstMinor; c.sgst += l.sgstMinor; c.igst += l.igstMinor;
      by.set(k, c);
    }
    if (y < M + 40 + by.size * 12) newPage();
    text("Tax summary by SAC", M, y, bold, 8); y -= 11;
    for (const [k, c] of by) { text(`SAC ${k}`, M, y, font, 8); right(`Taxable ${pdfMoney(c.net)}  CGST ${pdfMoney(c.cgst)}  SGST ${pdfMoney(c.sgst)}  IGST ${pdfMoney(c.igst)}`, W - M, y, font, 8); y -= 11; }
    y -= 8;
  }
  if (inv.kind === "BILL_OF_SUPPLY") text("No GST has been charged on this document.", M, y);
  else if (!inv.supplier.registered) text("Supplier is not registered under GST.", M, y);

  for (const [title, body] of [["Payment instructions", inv.paymentInstructions], ["Terms", inv.terms], ["", inv.footerNote]] as const) {
    if (!body) continue;
    const lines = body.split(/\r?\n/).flatMap((l) => wrap(l, font, 8, W - 2 * M));
    if (y - (lines.length + 2) * 10 < M + 20) newPage();
    if (title) { text(title, M, y, bold, 8); y -= 11; }
    for (const l of lines) { text(l, M, y, font, 8); y -= 10; }
    y -= 6;
  }

  if (inv.signatureLabel) {
    if (y < M + 70) newPage();
    y -= 30;
    page.drawLine({ start: { x: W - M - 160, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.3, 0.3, 0.3) });
    right(inv.signatureLabel, W - M, y - 11, font, 8);
  }

  pages.forEach((p, i) => {
    p.drawText(pdfSafe(`${inv.number}  |  Page ${i + 1} of ${pages.length}  |  Computer generated document`), {
      x: M, y: 24, size: 7, font, color: rgb(0.45, 0.45, 0.45),
    });
  });
  doc.setTitle(pdfSafe(`${TITLES[inv.kind] ?? inv.kind} ${inv.number}`));
  doc.setCreator("MK Hotel PMS");
  return doc.save();
}
