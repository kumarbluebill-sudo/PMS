import { describe, expect, it } from "vitest";
import { discountedRate, normalizeMobile } from "./quote";

describe("discountedRate", () => {
  it("applies percentages in basis points with half-up rounding", () => {
    expect(discountedRate(450_000, { percentBp: 1000 })).toBe(405_000);
    expect(discountedRate(33_333, { percentBp: 1000 })).toBe(30_000); // 3333.3 off rounds to 3333
  });
  it("applies fixed amounts and never goes negative", () => {
    expect(discountedRate(450_000, { amountMinor: 50_000 })).toBe(400_000);
    expect(discountedRate(450_000, { amountMinor: 900_000 })).toBe(0);
    expect(discountedRate(450_000)).toBe(450_000);
  });
  it("rejects ambiguous or invalid discounts", () => {
    expect(() => discountedRate(1000, { percentBp: 100, amountMinor: 100 })).toThrow();
    expect(() => discountedRate(1000, { percentBp: 10_001 })).toThrow();
    expect(() => discountedRate(1000, { amountMinor: -1 })).toThrow();
    expect(() => discountedRate(10.5)).toThrow();
  });
});

describe("normalizeMobile", () => {
  it("accepts common formats and strips punctuation", () => {
    expect(normalizeMobile("98765 43210")).toBe("9876543210");
    expect(normalizeMobile("+91-98765-43210")).toBe("+919876543210");
  });
  it("rejects junk and bad lengths", () => {
    expect(normalizeMobile("abc")).toBeNull();
    expect(normalizeMobile("12345")).toBeNull();
    expect(normalizeMobile("9876543210123456")).toBeNull();
    expect(normalizeMobile("98765x3210")).toBeNull();
  });
});
