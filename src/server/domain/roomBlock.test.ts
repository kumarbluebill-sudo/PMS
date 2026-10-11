import { describe, expect, it } from "vitest";
import { blockCoversDate, blockOverlapsStay } from "./roomBlock";

describe("block windows", () => {
  const w = { startDate: "2026-10-10", expectedResolution: "2026-10-12" };
  it("covers start and end dates inclusively", () => {
    expect(blockCoversDate(w, "2026-10-09")).toBe(false);
    expect(blockCoversDate(w, "2026-10-10")).toBe(true);
    expect(blockCoversDate(w, "2026-10-12")).toBe(true);
    expect(blockCoversDate(w, "2026-10-13")).toBe(false);
  });
  it("open-ended windows cover everything from the start", () => {
    expect(blockCoversDate({ startDate: null, expectedResolution: null }, "2030-01-01")).toBe(true);
    expect(blockCoversDate({ startDate: "2026-10-10", expectedResolution: null }, "2026-10-09")).toBe(false);
  });
  it("a stay overlaps when any night falls inside the window", () => {
    expect(blockOverlapsStay(w, "2026-10-08", "2026-10-10")).toBe(false); // last night is the 9th
    expect(blockOverlapsStay(w, "2026-10-08", "2026-10-11")).toBe(true);
    expect(blockOverlapsStay(w, "2026-10-12", "2026-10-14")).toBe(true); // arrives on the last blocked day
    expect(blockOverlapsStay(w, "2026-10-13", "2026-10-14")).toBe(false);
    expect(blockOverlapsStay({ startDate: null, expectedResolution: null }, "2030-01-01", "2030-01-02")).toBe(true);
  });
});
