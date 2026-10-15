import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from "pdf-lib";
import { resolveInvoiceStyle, type InvoiceFont, type InvoiceStyle } from "@/server/domain/invoiceTheme";
import { pdfMoney, pdfSafe } from "./invoice";

export type PdfConfirmation = {
  hotel: { name: string; address?: string | null; gstin?: string | null; phone?: string | null; email?: string | null; checkInTime: string; checkOutTime: string };
  /** PNG or JPEG bytes of the hotel's logo, when it could be fetched. Text is used otherwise. */
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null;
  headerText?: string | null;
  footerText?: string | null;
  /** One line shown under the title when this room is part of a group booking. */
  groupSummary?: string | null;
  references: string[];
  status: string;
  guest: { name: string; phone?: string | null; email?: string | null };
  arrival: string;
  departure: string;
  nights: number;
  adults: number;
  children: number;
  category: string;
  room: string | null;
  nightly: { date: string; rateMinor: number; taxMinor: number; totalMinor: number }[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Null when the viewer has no billing access; the money block then shows the total only. */
  paidMinor: number | null;
  taxNote?: string | null;
  policies: { title: string; body: string }[];
  style?: InvoiceStyle;
};

const FONTS: Record<InvoiceFont, [StandardFonts, StandardFonts]> = {
  HELVETICA: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  TIMES: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  COURIER: [StandardFonts.Courier, StandardFonts.CourierBold],
};

function wrap(text: string, f: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split(/\r?\n/)) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

/** A printable booking confirmation: who, when, what room, the nightly rates, tax, advance, balance and the policies. */
export async function renderConfirmationPdf(c: PdfConfirmation): Promise<Uint8Array> {
  const S = c.style ?? resolveInvoiceStyle();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(FONTS[S.font][0]);
  const bold = await doc.embedFont(FONTS[S.font][1]);
  const W = 595, H = 842, M = 44, size = 9.5;
  const accent = rgb(...S.accent), ruleCol = rgb(...S.rule), ink = rgb(0.1, 0.1, 0.1);
  let page = doc.addPage([W, H]);
  const pages = [page];
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); y = H - M; };
  const need = (h: number) => { if (y - h < M + 20) newPage(); };
  const put = (t: string, x: number, yy: number, f = font, sz = size, color = ink) => page.drawText(pdfSafe(t), { x, y: yy, size: sz, font: f, color });
  const putRight = (t: string, xr: number, yy: number, f = font, sz = size) => { const v = pdfSafe(t); page.drawText(v, { x: xr - f.widthOfTextAtSize(v, sz), y: yy, size: sz, font: f, color: ink }); };
  const rule = () => page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: ruleCol });
  if (S.topBar) page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: ruleCol });

  let logo: PDFImage | null = null;
  if (c.logo) {
    try { logo = c.logo.type === "png" ? await doc.embedPng(c.logo.bytes) : await doc.embedJpg(c.logo.bytes); } catch { logo = null; }
  }
  let left = M;
  if (logo) {
    const scale = Math.min(60 / logo.height, 140 / logo.width, 1);
    page.drawImage(logo, { x: M, y: y - logo.height * scale + 6, width: logo.width * scale, height: logo.height * scale });
    left = M + logo.width * scale + 12;
  }
  put(c.hotel.name, left, y - 8, bold, 15, accent);
  let hy = y - 24;
  for (const l of [c.hotel.address, c.hotel.phone || c.hotel.email ? [c.hotel.phone, c.hotel.email].filter(Boolean).join(" · ") : null, c.hotel.gstin ? `GSTIN: ${c.hotel.gstin}` : null].filter((x): x is string => !!x)) {
    for (const w of wrap(l, font, 8.5, W - left - M)) { put(w, left, hy, font, 8.5); hy -= 11; }
  }
  y = Math.min(hy, y - (logo ? 54 : 30)) - 6;
  rule();
  y -= 22;

  put("Booking confirmation", M, y, bold, 16, accent);
  putRight(c.references.join("  "), W - M, y, bold, 12);
  y -= 14;
  if (c.groupSummary) { for (const l of wrap(c.groupSummary, bold, 9, W - 2 * M)) { put(l, M, y, bold, 9); y -= 12; } }
  if (c.status === "TENTATIVE") { put("Pending: the room is held but the booking is not yet confirmed.", M, y, bold, 9, rgb(0.55, 0.3, 0)); y -= 12; }
  y -= 8;
  if (c.headerText) for (const l of wrap(c.headerText, font, size, W - 2 * M)) { put(l, M, y); y -= 12; }

  const rows: [string, string][] = [
    ["Guest", [c.guest.name, c.guest.phone, c.guest.email].filter(Boolean).join(" · ")],
    ["Arrival", `${c.arrival} from ${c.hotel.checkInTime}`],
    ["Departure", `${c.departure} by ${c.hotel.checkOutTime}`],
    ["Nights", String(c.nights)],
    ["Guests", `${c.adults} adult(s), ${c.children} child(ren)`],
    ["Room", `${c.category}${c.room ? `, room ${c.room}` : ", room to be assigned"}`],
  ];
  y -= 4;
  for (const [k, v] of rows) { need(14); put(k, M, y, font, 9, rgb(0.35, 0.35, 0.35)); put(v, M + 90, y); y -= 14; }
  y -= 8;

  need(40);
  if (S.headFill) page.drawRectangle({ x: M - 3, y: y - 5, width: W - 2 * M + 6, height: 17, color: rgb(...S.headFill) });
  put("Night", M, y, bold, 9); putRight("Rate", M + 240, y, bold, 9); putRight("Tax", M + 330, y, bold, 9); putRight("Total", W - M, y, bold, 9);
  y -= 6; rule(); y -= 13;
  for (const n of c.nightly) {
    need(14);
    put(n.date, M, y); putRight(pdfMoney(n.rateMinor), M + 240, y); putRight(pdfMoney(n.taxMinor), M + 330, y); putRight(pdfMoney(n.totalMinor), W - M, y);
    y -= 13 + S.rowGap / 2;
  }
  y += 4; rule(); y -= 16;
  const totals: [string, string, boolean][] = [["Subtotal", pdfMoney(c.subtotalMinor), false], ["Tax", pdfMoney(c.taxMinor), false], ["Total booking value", pdfMoney(c.totalMinor), true]];
  if (c.paidMinor !== null) totals.push(["Advance received", pdfMoney(c.paidMinor), false], ["Balance due", pdfMoney(Math.max(0, c.totalMinor - c.paidMinor)), true]);
  for (const [k, v, b] of totals) { need(16); put(k, W - M - 210, y, b ? bold : font, b ? 11 : size); putRight(v, W - M, y, b ? bold : font, b ? 11 : size); y -= b ? 18 : 14; }
  if (c.taxNote) { need(24); for (const l of wrap(c.taxNote, font, 8, W - 2 * M)) { put(l, M, y, font, 8); y -= 10; } }
  y -= 8;

  for (const p of c.policies) {
    const lines = wrap(p.body, font, 8.5, W - 2 * M);
    need(14 + lines.length * 11);
    put(p.title, M, y, bold, 9); y -= 12;
    for (const l of lines) { put(l, M, y, font, 8.5); y -= 11; }
    y -= 6;
  }
  if (c.footerText) { for (const l of wrap(c.footerText, font, size, W - 2 * M)) { need(14); put(l, M, y); y -= 12; } }
  need(30);
  put("Amounts are estimates until the final bill is issued at check-out. Please carry a valid photo ID.", M, y - 6, font, 8, rgb(0.4, 0.4, 0.4));

  pages.forEach((p, i) => p.drawText(pdfSafe(`${c.references[0] ?? "Booking"}  |  Page ${i + 1} of ${pages.length}  |  Computer generated document`), { x: M, y: 24, size: 7, font, color: rgb(0.45, 0.45, 0.45) }));
  doc.setTitle(pdfSafe(`Booking confirmation ${c.references.join(" ")}`));
  doc.setCreator("MK Hotel PMS");
  return doc.save();
}
