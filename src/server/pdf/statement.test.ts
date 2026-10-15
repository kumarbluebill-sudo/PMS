import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderStatementPdf, type PdfStatement } from "./statement";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
  date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, description: `Room night ${i + 1} deluxe with a long description that wraps`, kind: "CHARGE",
  quantity: 1, taxableMinor: 450_000, taxMinor: 54_000, amountMinor: 504_000, reference: "",
}));
const base = (n: number): PdfStatement => ({
  hotel: { name: "Bill Co", address: "1 Beach Road", gstin: "33ABCDE1234F1Z5" }, guest: "Asha Verma", reservation: "R-1", stay: "12 Oct to 15 Oct", asOf: "15 Oct 2026",
  rows: rows(n), summary: { billedMinor: 504_000 * n, paidMinor: 100_000, refundedMinor: 0, balanceMinor: 504_000 * n - 100_000 },
});

describe("renderStatementPdf", () => {
  it("renders a one-page statement and paginates long ones", async () => {
    expect((await PDFDocument.load(await renderStatementPdf(base(3)))).getPageCount()).toBe(1);
    expect((await PDFDocument.load(await renderStatementPdf(base(80)))).getPageCount()).toBeGreaterThan(1);
  });
  it("works with every theme", async () => {
    const { INVOICE_THEMES, resolveInvoiceStyle } = await import("@/server/domain/invoiceTheme");
    for (const theme of INVOICE_THEMES) {
      const bytes = await renderStatementPdf({ ...base(2), style: resolveInvoiceStyle({ theme }) });
      expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    }
  });
});
