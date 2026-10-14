import { describe, expect, it } from "vitest";
import { arr, countedStatuses, dayKind, isNoShowCandidate, occupancyPct, revpar, sortAlerts, timeInZone } from "./kpi";

describe("kpi formulas", () => {
  it("labels past, today and future nights", () => {
    expect([dayKind("2026-10-13", "2026-10-14"), dayKind("2026-10-14", "2026-10-14"), dayKind("2026-10-15", "2026-10-14")]).toEqual(["ACTUAL", "LIVE", "FORECAST"]);
  });
  it("counts only valid stays for each kind of night", () => {
    expect(countedStatuses("ACTUAL")).toEqual(["CHECKED_IN", "CHECKED_OUT"]);
    expect(countedStatuses("LIVE")).toEqual(["CHECKED_IN"]);
    expect(countedStatuses("FORECAST")).toContain("CONFIRMED");
    for (const k of ["ACTUAL", "LIVE", "FORECAST"] as const) {
      for (const bad of ["CANCELLED", "NO_SHOW", "TENTATIVE", "INQUIRY"]) expect(countedStatuses(k)).not.toContain(bad);
    }
  });
  it("computes occupancy, ARR and RevPAR with safe zero handling", () => {
    expect(occupancyPct(3, 8)).toBe(37.5);
    expect(occupancyPct(0, 0)).toBe(0);
    expect(arr(900_000, 3)).toBe(300_000);
    expect(arr(0, 0)).toBeNull();
    expect(revpar(900_000, 8)).toBe(112_500);
    expect(revpar(900_000, 0)).toBeNull();
  });
  it("RevPAR equals occupancy times ARR", () => {
    const revenue = 1_234_500, sold = 7, sellable = 20;
    expect(revpar(revenue, sellable)!).toBeCloseTo((sold / sellable) * arr(revenue, sold)!, -1);
  });
});

describe("no-show candidates", () => {
  it("never flags future arrivals, flags past ones, and honours the cutoff today", () => {
    expect(isNoShowCandidate("2026-10-15", "2026-10-14", "23:59", "22:00")).toBe(false);
    expect(isNoShowCandidate("2026-10-13", "2026-10-14", "09:00", "22:00")).toBe(true);
    expect(isNoShowCandidate("2026-10-14", "2026-10-14", "21:59", "22:00")).toBe(false);
    expect(isNoShowCandidate("2026-10-14", "2026-10-14", "22:00", "22:00")).toBe(true);
  });
});

describe("helpers", () => {
  it("sorts alerts by severity then title", () => {
    const s = sortAlerts([
      { severity: "INFO" as const, title: "b" }, { severity: "CRITICAL" as const, title: "z" },
      { severity: "WARNING" as const, title: "a" }, { severity: "CRITICAL" as const, title: "a" },
    ]);
    expect(s.map((x) => `${x.severity[0]}${x.title}`)).toEqual(["Ca", "Cz", "Wa", "Ib"]);
  });
  it("formats local time in a zone", () => {
    expect(timeInZone(new Date("2026-10-14T16:30:00Z"), "Asia/Kolkata")).toBe("22:00");
  });
});
