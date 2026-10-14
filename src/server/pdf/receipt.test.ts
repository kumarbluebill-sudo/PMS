import { describe, expect, it } from "vitest";
import { isAdvance, renderReceiptPdf, type PdfReceipt } from "./receipt";

const base: PdfReceipt = {
  id: "abcdef12-0000-0000-0000-000000000000", advance: false, date: "2026-10-14",
  hotel: { name: "Hotel ₹ Test", address: "1 Main Road", gstin: null }, guest: "A Guest", reference: "MK-1", stay: "a to b",
  method: "cash", receivedBy: "Staff", amountMinor: 123456, balanceAfterMinor: 0, layout: "A4",
};

describe("receipt pdf", () => {
  it("renders A4 and thermal layouts as valid PDFs", async () => {
    for (const layout of ["A4", "THERMAL"] as const) {
      const bytes = await renderReceiptPdf({ ...base, layout, advance: layout === "THERMAL", signatureLabel: "Authorised signatory", footer: "Thank you\nVisit again" });
      expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(800);
    }
  });
  it("detects advance payments", () => {
    const arrival = new Date("2026-10-20");
    expect(isAdvance("CONFIRMED", new Date("2026-10-14"), arrival)).toBe(true);
    expect(isAdvance("CHECKED_IN", new Date("2026-10-14"), arrival)).toBe(false);
    expect(isAdvance("CONFIRMED", new Date("2026-10-21"), arrival)).toBe(false);
  });
});
