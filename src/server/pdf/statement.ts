import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { resolveInvoiceStyle, type InvoiceStyle } from "@/server/domain/invoiceTheme";
import { pdfMoney, pdfSafe } from "./invoice";

export type StatementRow = {
  date: string; description: string; kind: string; quantity: number | null; taxableMinor: number; taxMinor: number; amountMinor: number; reference: string;
};
export type PdfStatement = {
  hotel: { name: string; address?: string | null; gstin?: string | null };
  headerLine?: string | null;
  guest: string;
  reservation: string;
  stay: string;
  asOf: string;
  billTo?: string | null;
  rows: StatementRow[];
  summary: { billedMinor: number; paidMinor: number; refundedMinor: number; balanceMinor: number };
  style?: InvoiceStyle;
  /** "Guest folio statement" by default; "Interim bill" for a bill to date. */
  title?: string;
  notice?: string;
};

/**
 * Guest folio statement: every posting with its payments, as a record of the account. It is not a tax invoice and
 * says so on the page.
 */
export async function renderStatementPdf(s: PdfStatement): Promise<Uint8Array> {
  const S = s.style ?? resolveInvoiceStyle();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 40, size = 8.5;
  const accent = rgb(...S.accent), ruleCol = rgb(...S.rule), ink = rgb(0.1, 0.1, 0.1);
  const cols = [{ w: 52, t: "Date" }, { w: 182, t: "Description" }, { w: 28, t: "Qty" }, { w: 66, t: "Taxable" }, { w: 54, t: "GST" }, { w: 72, t: "Amount" }, { w: 61, t: "Ref" }];
  const wrap = (text: string, f: PDFFont, sz: number, width: number) => {
    const out: string[] = [];
    let line = "";
    for (const w of pdfSafe(text).split(/\s+/)) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, sz) <= width || !line) line = next;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };

  let page = doc.addPage([W, H]);
  const pages = [page];
  let y = H - M;
  const put = (t: string, x: number, yy: number, f = font, sz = size, color = ink) => page.drawText(pdfSafe(t), { x, y: yy, size: sz, font: f, color });
  const putRight = (t: string, xr: number, yy: number, f = font, sz = size) => {
    const v = pdfSafe(t);
    page.drawText(v, { x: xr - f.widthOfTextAtSize(v, sz), y: yy, size: sz, font: f, color: ink });
  };
  const rule = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.6, color: ruleCol });
  const header = () => {
    if (S.headFill) page.drawRectangle({ x: M - 3, y: y - 8, width: W - 2 * M + 6, height: 18, color: rgb(...S.headFill) });
    let x = M;
    cols.forEach((c, i) => {
      if (i === 0 || i === 1 || i === 6) put(c.t, x, y, bold, 8);
      else putRight(c.t, x + c.w - 4, y, bold, 8);
      x += c.w;
    });
    y -= 6;
    rule(y);
    y -= 12;
  };

  if (S.topBar) page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: ruleCol });
  put(s.title ?? "Guest folio statement", M, y - 14, bold, 16, accent);
  put(s.notice ?? "Statement of account. This is not a tax invoice.", M, y - 28, font, 8);
  put(`As of ${s.asOf}`, M, y - 40);
  let ry = y - 14;
  const sup = [s.hotel.name, ...(s.hotel.address ? wrap(s.hotel.address, font, size, 230) : []), ...(s.hotel.gstin ? [`GSTIN: ${s.hotel.gstin}`] : [])];
  if (s.headerLine) sup.splice(1, 0, s.headerLine);
  sup.forEach((l, i) => { putRight(l, W - M, ry, i === 0 ? bold : font, i === 0 ? 11 : size); ry -= 12; });
  y = Math.min(y - 52, ry) - 8;
  rule(y);
  y -= 16;
  put(`Guest: ${s.guest}`, M, y, bold, 10);
  y -= 13;
  put(`Reservation ${s.reservation} · ${s.stay}`, M, y);
  y -= 12;
  if (s.billTo) { put(`Billed to: ${s.billTo}`, M, y); y -= 12; }
  y -= 8;
  header();

  for (const r of s.rows) {
    const desc = wrap(r.description, font, size, cols[1].w - 6);
    if (y - desc.length * 10 < M + 110) {
      page = doc.addPage([W, H]);
      pages.push(page);
      y = H - M;
      header();
    }
    let x = M;
    put(r.date, x, y); x += cols[0].w;
    desc.forEach((d, i) => put(d, x, y - i * 10)); x += cols[1].w;
    if (r.quantity) putRight(String(r.quantity), x + cols[2].w - 4, y); x += cols[2].w;
    if (r.taxableMinor) putRight(pdfMoney(r.taxableMinor), x + cols[3].w - 4, y); x += cols[3].w;
    if (r.taxMinor) putRight(pdfMoney(r.taxMinor), x + cols[4].w - 4, y); x += cols[4].w;
    putRight(pdfMoney(r.amountMinor), x + cols[5].w - 4, y); x += cols[5].w;
    if (r.reference) put(wrap(r.reference, font, 7, cols[6].w - 2)[0], x, y, font, 7);
    y -= Math.max(1, desc.length) * 10 + S.rowGap;
  }
  rule(y + 6);
  y -= 8;
  if (y < M + 90) { page = doc.addPage([W, H]); pages.push(page); y = H - M; }
  const rowsOut: [string, number, boolean][] = [
    ["Total billed (incl. GST)", s.summary.billedMinor, false], ["Payments received", s.summary.paidMinor, false],
    ...(s.summary.refundedMinor ? [["Refunds", s.summary.refundedMinor, false] as [string, number, boolean]] : []),
    ["Balance due", s.summary.balanceMinor, true],
  ];
  for (const [l, v, b] of rowsOut) {
    put(l, W - M - 220, y, b ? bold : font, b ? 11 : size);
    putRight(pdfMoney(v), W - M, y, b ? bold : font, b ? 11 : size);
    y -= b ? 18 : 13;
  }
  pages.forEach((p, i) => p.drawText(pdfSafe(`Statement ${s.reservation}  |  Page ${i + 1} of ${pages.length}  |  Computer generated document`), { x: M, y: 24, size: 7, font, color: rgb(0.45, 0.45, 0.45) }));
  doc.setTitle(pdfSafe(`Folio statement ${s.reservation}`));
  doc.setCreator("MK Hotel PMS");
  return doc.save();
}
