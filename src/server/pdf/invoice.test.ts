import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { pdfMoney, pdfSafe, renderInvoicePdf, type PdfInvoice } from "./invoice";

const line = (i: number) => ({
  description: `Room charge 2026-10-${String((i % 28) + 1).padStart(2, "0")} deluxe room with a very long description that has to wrap over lines ₹`,
  sacCode: "996311", netMinor: 450_000, cgstMinor: 27_000, sgstMinor: 27_000, igstMinor: 0, cessMinor: 0, grossMinor: 504_000,
});
const base = (kind: string, n: number): PdfInvoice => ({
  number: "BI/2627/000001", kind, issuedDate: "2026-10-12", supplier: { name: "Bill Co Pvt Ltd", address: "1 Beach Road, Chennai", gstin: "33ABCDE1234F1Z5", registered: true },
  recipient: { name: "Asha Verma", gstin: null }, placeOfSupply: "33", placeOfSupplyName: "Tamil Nadu",
  lines: Array.from({ length: n }, (_, i) => line(i)),
  totals: { netMinor: 450_000 * n, cgstMinor: 27_000 * n, sgstMinor: 27_000 * n, igstMinor: 0, cessMinor: 0, grossMinor: 504_000 * n },
});

describe("pdf helpers", () => {
  it("formats rupees with Indian grouping and no unsupported glyphs", () => {
    expect(pdfMoney(12_345_600)).toBe("Rs. 1,23,456.00");
    expect(pdfMoney(-5)).toBe("-Rs. 0.05");
    expect(pdfSafe("₹5 नमस्ते")).toBe("Rs.5 ??????");
  });
});

describe("renderInvoicePdf", () => {
  it("produces a valid one-page PDF for a short tax invoice", async () => {
    const bytes = await renderInvoicePdf(base("TAX_INVOICE", 2));
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Tax Invoice BI/2627/000001");
  });
  it("paginates long invoices", async () => {
    const doc = await PDFDocument.load(await renderInvoicePdf(base("TAX_INVOICE", 60)));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
  it("renders bills of supply, credit and debit notes without error", async () => {
    for (const kind of ["BILL_OF_SUPPLY", "CREDIT_NOTE", "DEBIT_NOTE"]) {
      const inv = { ...base(kind, 3), originalNumber: "BI/2627/000000", reason: "Correction" };
      expect((await renderInvoicePdf(inv)).length).toBeGreaterThan(1000);
    }
  });
  it("survives an unbreakable long word and empty fields", async () => {
    const inv = base("TAX_INVOICE", 1);
    inv.lines[0].description = "X".repeat(400);
    inv.recipient = {};
    expect((await renderInvoicePdf(inv)).length).toBeGreaterThan(1000);
  });
});

import { inflateSync } from "node:zlib";

/** Concatenates the decompressed content streams so the drawn text can be searched. */
function inflateStreams(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const src = buf.toString("latin1");
  let out = "";
  for (const m of src.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = src.indexOf("endstream", start);
    try { out += inflateSync(buf.subarray(start, end)).toString("latin1"); } catch { /* not a flate stream */ }
  }
  return out;
}

describe("invoice themes", () => {
  // The content stream carries text as hex strings; the same figures must appear whatever the theme.
  const hexOf = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();
  it("renders every theme and font with the same totals and legal fields", async () => {
    const { INVOICE_THEMES, INVOICE_FONTS, resolveInvoiceStyle } = await import("@/server/domain/invoiceTheme");
    const combos = [
      ...INVOICE_THEMES.map((theme) => resolveInvoiceStyle({ theme })),
      ...INVOICE_FONTS.map((font) => resolveInvoiceStyle({ theme: "MODERN", font, accent: "#ffcc00" })),
    ];
    for (const style of combos) {
      const bytes = await renderInvoicePdf({ ...base("TAX_INVOICE", 3), style });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      const raw = inflateStreams(bytes);
      const hasText = (t: string) => raw.toUpperCase().includes(hexOf(t)) || raw.includes(t);
      expect(hasText("15,120.00"), `${style.theme}/${style.font} total`).toBe(true);
      expect(hasText("33ABCDE1234F1Z5"), `${style.theme}/${style.font} gstin`).toBe(true);
    }
  });
});
