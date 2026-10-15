import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { INVOICE_THEMES, resolveInvoiceStyle } from "@/server/domain/invoiceTheme";
import { renderConfirmationPdf, type PdfConfirmation } from "./confirmation";

const base = (nights: number): PdfConfirmation => ({
  hotel: { name: "Palm Resort", address: "1 Beach Road, Goa", gstin: "30ABCDE1234F1Z5", phone: "+91 98765 43210", email: "front@palm.test", checkInTime: "14:00", checkOutTime: "11:00" },
  references: ["MK-1A2B3C4D"], status: "CONFIRMED", guest: { name: "Asha Verma", phone: "9876543210", email: "asha@test.local" },
  arrival: "2026-11-02", departure: "2026-11-04", nights, adults: 2, children: 0, category: "Deluxe", room: "101",
  nightly: Array.from({ length: nights }, (_, i) => ({ date: `2026-11-${String(2 + (i % 26)).padStart(2, "0")}`, rateMinor: 450_000, taxMinor: 54_000, totalMinor: 504_000 })),
  subtotalMinor: 450_000 * nights, taxMinor: 54_000 * nights, totalMinor: 504_000 * nights, paidMinor: 200_000, taxNote: null,
  policies: [{ title: "Cancellation policy", body: "Free until 48 hours before arrival. After that the first night is charged. ".repeat(6) }],
});

describe("renderConfirmationPdf", () => {
  it("renders a one-page confirmation and paginates a long stay", async () => {
    expect((await PDFDocument.load(await renderConfirmationPdf(base(2)))).getPageCount()).toBe(1);
    expect((await PDFDocument.load(await renderConfirmationPdf(base(70)))).getPageCount()).toBeGreaterThan(1);
  });
  it("renders without money for staff without billing access, pending bookings, and every theme", async () => {
    for (const theme of INVOICE_THEMES) {
      const bytes = await renderConfirmationPdf({ ...base(3), paidMinor: null, status: "TENTATIVE", style: resolveInvoiceStyle({ theme }) });
      expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    }
  });
  it("ignores a logo that is not a valid image instead of failing", async () => {
    const bytes = await renderConfirmationPdf({ ...base(2), logo: { bytes: new Uint8Array([1, 2, 3]), type: "png" } });
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
  });
});
