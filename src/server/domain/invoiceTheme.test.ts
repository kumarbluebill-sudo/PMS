import { describe, expect, it } from "vitest";
import { legibleOnWhite, resolveInvoiceStyle } from "./invoiceTheme";

describe("invoice themes", () => {
  it("falls back to classic for unknown input", () => {
    expect(resolveInvoiceStyle({ theme: "nope" }).theme).toBe("CLASSIC");
    expect(resolveInvoiceStyle().font).toBe("HELVETICA");
  });
  it("applies a custom accent only to coloured themes", () => {
    expect(resolveInvoiceStyle({ theme: "CLASSIC", accent: "#ff0000" }).rule).toEqual(resolveInvoiceStyle({ theme: "CLASSIC" }).rule);
    const m = resolveInvoiceStyle({ theme: "MODERN", accent: "#ff0000" });
    expect(m.rule[0]).toBe(1);
  });
  it("darkens a pale accent for text and honours a font choice", () => {
    const pale = legibleOnWhite([1, 0.95, 0.6]);
    expect(pale[2]).toBeLessThan(0.6);
    expect(resolveInvoiceStyle({ theme: "LUXURY", font: "COURIER" }).font).toBe("COURIER");
  });
});
