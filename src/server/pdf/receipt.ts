import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfMoney, pdfSafe } from "./invoice";

export type PdfReceipt = {
  id: string;
  advance: boolean;
  date: string;
  hotel: { name: string; address?: string | null; gstin?: string | null };
  headerLine?: string | null;
  guest: string;
  reference: string;
  stay: string;
  method: string;
  paymentRef?: string | null;
  receivedBy: string;
  amountMinor: number;
  balanceAfterMinor: number;
  footer?: string | null;
  signatureLabel?: string | null;
  layout: "A4" | "THERMAL";
};

/** A payment taken before the guest arrives (and before check-in) is an advance. */
export const isAdvance = (reservationStatus: string, receivedAt: Date, arrival: Date) =>
  !["CHECKED_IN", "CHECKED_OUT"].includes(reservationStatus) && receivedAt.getTime() < arrival.getTime();

function wrapText(text: string, widthOf: (s: string) => number, max: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split(/\r?\n/)) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (widthOf(next) <= max || !line) line = next;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

/** Acknowledgement of money received. Not a tax invoice. A4 or 80 mm receipt-printer width. */
export async function renderReceiptPdf(r: PdfReceipt): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const thermal = r.layout === "THERMAL";
  const W = thermal ? 226 : 595;
  const M = thermal ? 12 : 40;
  const size = thermal ? 8 : 10;
  const lines: { t: string; b?: boolean; s?: number; gap?: number }[] = [];
  const add = (t: string, o: { b?: boolean; s?: number; gap?: number } = {}) => {
    const f = o.b ? bold : font;
    const sz = o.s ?? size;
    for (const l of wrapText(t, (x) => f.widthOfTextAtSize(x, sz), W - 2 * M)) lines.push({ t: l, ...o });
  };
  add(r.hotel.name, { b: true, s: size + 4 });
  if (r.headerLine) add(r.headerLine);
  if (r.hotel.address) add(r.hotel.address);
  if (r.hotel.gstin) add(`GSTIN: ${r.hotel.gstin}`);
  add(r.advance ? "ADVANCE RECEIPT" : "PAYMENT RECEIPT", { b: true, s: size + 2, gap: 8 });
  add(`Receipt no: ${r.id.slice(0, 8).toUpperCase()}`);
  add(`Date: ${r.date}`);
  add(`Received from: ${r.guest}`, { gap: 6 });
  add(`Booking: ${r.reference}`);
  add(`Stay: ${r.stay}`);
  add(`Method: ${r.method}`);
  if (r.paymentRef) add(`Reference: ${r.paymentRef}`);
  add(`Received by: ${r.receivedBy}`);
  add(pdfMoney(r.amountMinor), { b: true, s: size + 8, gap: 10 });
  add(`Balance on folio after this payment: ${pdfMoney(r.balanceAfterMinor)}`);
  add(r.advance ? "This is an advance received against a future stay. It is not a tax invoice." : "This receipt acknowledges money received. It is not a tax invoice.", { s: size - 1, gap: 8 });
  if (r.footer) add(r.footer, { s: size - 1, gap: 4 });

  const lh = (l: { s?: number; gap?: number }) => (l.s ?? size) * 1.35 + (l.gap ?? 0);
  const total = lines.reduce((n, l) => n + lh(l), 0) + 2 * M + (r.signatureLabel ? 50 : 0);
  const H = thermal ? Math.max(200, total) : 842;
  const page = doc.addPage([W, H]);
  let y = H - M;
  for (const l of lines) {
    y -= (l.gap ?? 0) + (l.s ?? size);
    page.drawText(l.t, { x: M, y, size: l.s ?? size, font: l.b ? bold : font, color: rgb(0.1, 0.1, 0.1) });
    y -= (l.s ?? size) * 0.35;
  }
  if (r.signatureLabel) {
    y -= 34;
    page.drawLine({ start: { x: W - M - 130, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.3, 0.3, 0.3) });
    const t = pdfSafe(r.signatureLabel);
    page.drawText(t, { x: W - M - font.widthOfTextAtSize(t, size - 1), y: y - 10, size: size - 1, font, color: rgb(0.1, 0.1, 0.1) });
  }
  doc.setTitle(pdfSafe(`${r.advance ? "Advance" : "Payment"} receipt ${r.id.slice(0, 8)}`));
  doc.setCreator("MK Hotel PMS");
  return doc.save();
}
