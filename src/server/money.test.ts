import { describe, expect, it } from "vitest";
import { formatInr, rupeesToMinor } from "./money";

describe("rupeesToMinor", () => {
  it("parses without floating-point error", () => {
    expect(rupeesToMinor("0.10")).toBe(10);
    expect(rupeesToMinor("19.99")).toBe(1999);
    expect(rupeesToMinor("1,234.5")).toBe(123450);
    expect(rupeesToMinor("100")).toBe(10000);
    expect(rupeesToMinor("0.07")).toBe(7);
  });
  it("rejects junk, negatives and 3 decimals", () => {
    for (const bad of ["", "abc", "-5", "1.234", "1e5", "12.", "1000000000"]) expect(() => rupeesToMinor(bad)).toThrow();
  });
});

describe("formatInr", () => {
  it("uses Indian digit grouping", () => {
    expect(formatInr(123456789)).toBe("₹12,34,567.89");
    expect(formatInr(-5)).toBe("-₹0.05");
  });
});
