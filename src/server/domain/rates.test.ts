import { describe, expect, it } from "vitest";
import { effectiveExtras, effectiveNightRates, findPlanConflicts, planCovers, postingRate, stayAllowed, type PlanInput } from "./rates";

const line = (roomTypeId: string, weekday: number, extra: Partial<PlanInput["rates"][number]> = {}) => ({
  roomTypeId, weekdayRateMinor: weekday, weekendRateMinor: null, singleOccupancyRateMinor: null, extraAdultRateMinor: null, extraChildRateMinor: null, ...extra,
});
const plan = (id: string, o: Partial<PlanInput> = {}): PlanInput => ({
  id, name: `Plan ${id}`, code: id.toUpperCase(), active: true, priority: 0, validFrom: null, validTo: null, weekendDays: [5, 6], minStay: null, maxStay: null,
  createdAt: 1, rates: [line("dlx", 500_000)], ...o,
});
// 2026-10-15 is a Thursday, so Fri = 16th and Sat = 17th.
const dates = ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
const q = (plans: PlanInput[], extra: Record<string, unknown> = {}) => effectiveNightRates({ roomTypeId: "dlx", baseRateMinor: 400_000, dates, adults: 2, children: 0, plans, ...extra });

describe("effectiveNightRates", () => {
  it("falls back to the base rate with no plan", () => {
    expect(q([]).map((n) => [n.rateMinor, n.basis])).toEqual(Array(4).fill([400_000, "BASE"]));
  });
  it("uses weekday and weekend rates by the plan's weekend days", () => {
    const r = q([plan("a", { rates: [line("dlx", 500_000, { weekendRateMinor: 650_000 })] })]);
    expect(r.map((n) => n.rateMinor)).toEqual([500_000, 650_000, 650_000, 500_000]);
    expect(r[1].basis).toBe("WEEKEND");
  });
  it("applies a seasonal plan only inside its dates and falls back to base outside", () => {
    const r = q([plan("s", { validFrom: "2026-10-16", validTo: "2026-10-17" })]);
    expect(r.map((n) => n.planId)).toEqual([null, "s", "s", null]);
    expect(r.map((n) => n.rateMinor)).toEqual([400_000, 500_000, 500_000, 400_000]);
  });
  it("breaks overlaps by priority, then the narrower window, then the newer plan", () => {
    const wide = plan("wide", { priority: 0, rates: [line("dlx", 450_000)] });
    const narrow = plan("narrow", { priority: 0, validFrom: "2026-10-16", validTo: "2026-10-17", rates: [line("dlx", 550_000)] });
    expect(q([wide, narrow]).map((n) => n.planId)).toEqual(["wide", "narrow", "narrow", "wide"]);
    const high = plan("high", { priority: 5, rates: [line("dlx", 700_000)] });
    expect(q([wide, narrow, high]).every((n) => n.planId === "high")).toBe(true);
    const older = plan("older", { createdAt: 1, rates: [line("dlx", 1)] });
    const newer = plan("newer", { createdAt: 2, rates: [line("dlx", 2)] });
    expect(q([older, newer])[0].planId).toBe("newer");
  });
  it("ignores inactive plans, other categories and stays that break min or max stay", () => {
    expect(q([plan("off", { active: false })])[0].planId).toBeNull();
    expect(q([plan("other", { rates: [line("ste", 900_000)] })])[0].planId).toBeNull();
    expect(q([plan("min", { minStay: 5 })])[0].planId).toBeNull();
    expect(q([plan("max", { maxStay: 3 })])[0].planId).toBeNull();
    expect(q([plan("ok", { minStay: 2, maxStay: 4 })])[0].planId).toBe("ok");
  });
  it("uses single occupancy for one adult, and honours a forced plan", () => {
    const p = plan("a", { rates: [line("dlx", 500_000, { singleOccupancyRateMinor: 420_000 })] });
    expect(q([p], { adults: 1 })[0]).toMatchObject({ rateMinor: 420_000, basis: "SINGLE" });
    expect(q([p], { adults: 1, children: 1 })[0].rateMinor).toBe(500_000);
    const other = plan("b", { priority: 9, rates: [line("dlx", 999_000)] });
    expect(q([p, other], { onlyPlanId: "a" })[0].planId).toBe("a");
    expect(q([p], { onlyPlanId: "missing" })[0].basis).toBe("BASE");
  });
});

describe("conflicts, extras and posting", () => {
  it("flags same-priority overlap on a shared category, but allows different priorities or disjoint dates", () => {
    const a = plan("a", { validFrom: "2026-10-01", validTo: "2026-10-31" });
    expect(findPlanConflicts(plan("b", { validFrom: "2026-10-20", validTo: "2026-11-05" }), [a])).toEqual([{ otherId: "a", otherName: "Plan a", roomTypeIds: ["dlx"] }]);
    expect(findPlanConflicts(plan("b", { priority: 1, validFrom: "2026-10-20", validTo: "2026-11-05" }), [a])).toEqual([]);
    expect(findPlanConflicts(plan("b", { validFrom: "2026-11-01", validTo: "2026-11-30" }), [a])).toEqual([]);
    expect(findPlanConflicts(plan("b", { rates: [line("ste", 1)] }), [a])).toEqual([]);
    expect(findPlanConflicts(plan("b", { active: false }), [a])).toEqual([]);
    expect(findPlanConflicts(plan("b"), [plan("c", { validFrom: "2027-01-01" }), plan("d", { active: false })]).map((c) => c.otherId)).toEqual(["c"]);
  });
  it("open-ended windows overlap everything after their start", () => {
    expect(findPlanConflicts(plan("b", { validFrom: "2030-01-01" }), [plan("a", { validFrom: "2026-01-01", validTo: null })]).length).toBe(1);
  });
  it("takes extras from the applied plan, else the category", () => {
    const p = plan("a", { rates: [line("dlx", 500_000, { extraAdultRateMinor: 150_000 })] });
    const nights = q([p]);
    expect(effectiveExtras(nights, [p], "dlx", { extraAdultRateMinor: 100_000, extraChildRateMinor: 50_000 })).toEqual({ extraAdultRateMinor: 150_000, extraChildRateMinor: 50_000 });
    expect(effectiveExtras(q([]), [], "dlx", { extraAdultRateMinor: 100_000, extraChildRateMinor: 50_000 })).toEqual({ extraAdultRateMinor: 100_000, extraChildRateMinor: 50_000 });
  });
  it("posts the frozen night first, then the agreed rate, then the current base", () => {
    expect(postingRate({ nightly: { "2026-10-15": 111 } }, "2026-10-15", 222, 333)).toBe(111);
    expect(postingRate({ nightly: {} }, "2026-10-15", 222, 333)).toBe(222);
    expect(postingRate(null, "2026-10-15", null, 333)).toBe(333);
  });
  it("covers plan windows and stay limits", () => {
    expect(planCovers({ active: true, validFrom: "2026-10-01", validTo: "2026-10-31" }, "2026-10-31")).toBe(true);
    expect(planCovers({ active: true, validFrom: "2026-10-01", validTo: "2026-10-31" }, "2026-11-01")).toBe(false);
    expect(stayAllowed({ minStay: 2, maxStay: null }, 1)).toBe(false);
  });
});
