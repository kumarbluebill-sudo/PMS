import { describe, expect, it } from "vitest";
import { addDays, barPlacement, stayEdges } from "./rack";

describe("rack layout", () => {
  it("places a stay inside the window", () => {
    expect(barPlacement("2026-10-12", "2026-10-15", "2026-10-10", 7)).toEqual({ col: 2, span: 3, cutLeft: false, cutRight: false });
  });
  it("clips stays that start before or end after the window", () => {
    expect(barPlacement("2026-10-08", "2026-10-12", "2026-10-10", 7)).toEqual({ col: 0, span: 2, cutLeft: true, cutRight: false });
    expect(barPlacement("2026-10-15", "2026-10-30", "2026-10-10", 7)).toEqual({ col: 5, span: 2, cutLeft: false, cutRight: true });
  });
  it("ignores stays outside the window, including one that departs on its first day", () => {
    expect(barPlacement("2026-10-01", "2026-10-10", "2026-10-10", 7)).toBeNull();
    expect(barPlacement("2026-10-17", "2026-10-19", "2026-10-10", 7)).toBeNull();
  });
  it("reports arrival and departure columns, and adds days across a month end", () => {
    expect(stayEdges("2026-10-12", "2026-10-15", "2026-10-10", 7)).toEqual({ arrivalCol: 2, departureCol: 5 });
    expect(stayEdges("2026-10-08", "2026-10-30", "2026-10-10", 7)).toEqual({ arrivalCol: null, departureCol: null });
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });
});
