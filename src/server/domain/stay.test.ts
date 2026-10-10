import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, nightsBetween, rangesOverlap, stayNights } from "./stay";

describe("stay dates (half-open)", () => {
  it("counts nights excluding departure day", () => {
    expect(nightsBetween("2026-03-01", "2026-03-04")).toBe(3);
    expect(stayNights("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28"]);
  });
  it("rejects zero/negative/invalid stays", () => {
    expect(() => nightsBetween("2026-03-01", "2026-03-01")).toThrow();
    expect(() => nightsBetween("2026-03-05", "2026-03-01")).toThrow();
    expect(() => nightsBetween("2026-02-30", "2026-03-02")).toThrow();
  });
  it("allows back-to-back stays but not overlaps", () => {
    expect(rangesOverlap("2026-03-01", "2026-03-03", "2026-03-03", "2026-03-05")).toBe(false);
    expect(rangesOverlap("2026-03-01", "2026-03-04", "2026-03-03", "2026-03-05")).toBe(true);
  });
});

describe("reservation state machine", () => {
  it("allows the normal lifecycle", () => {
    expect(canTransition("CONFIRMED", "CHECKED_IN")).toBe(true);
    expect(canTransition("CHECKED_IN", "CHECKED_OUT")).toBe(true);
  });
  it("blocks illegal transitions", () => {
    expect(() => assertTransition("CHECKED_OUT", "CONFIRMED")).toThrow();
    expect(() => assertTransition("CANCELLED", "CHECKED_IN")).toThrow();
    expect(() => assertTransition("CHECKED_IN", "CANCELLED")).toThrow();
  });
});
