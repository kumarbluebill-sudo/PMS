import { describe, expect, it } from "vitest";
import { extraPersonPerNight, summarizeFolio, type SummaryEntry } from "./folio";

const at = (d: string) => new Date(`${d}T10:00:00Z`);
const e = (o: Partial<SummaryEntry> & Pick<SummaryEntry, "kind" | "balanceDeltaMinor">): SummaryEntry => ({
  category: "ROOM", subCategory: null, netMinor: 0, taxMinor: 0, postedAt: at("2026-10-12"), ...o,
});

describe("extraPersonPerNight", () => {
  const rt = { baseOccupancy: 2, extraAdultRateMinor: 100_000, extraChildRateMinor: 50_000 };
  it("charges adults beyond the base occupancy and children only when a child rate exists", () => {
    expect(extraPersonPerNight({ ...rt, adults: 2, children: 0 })).toBe(0);
    expect(extraPersonPerNight({ ...rt, adults: 3, children: 0 })).toBe(100_000);
    expect(extraPersonPerNight({ ...rt, adults: 4, children: 2 })).toBe(300_000);
    expect(extraPersonPerNight({ ...rt, extraChildRateMinor: 0, adults: 1, children: 3 })).toBe(0);
  });
});

describe("summarizeFolio", () => {
  const entries: SummaryEntry[] = [
    e({ kind: "CHARGE", category: "ROOM", netMinor: 900_000, taxMinor: 108_000, balanceDeltaMinor: 1_008_000 }),
    e({ kind: "CHARGE", category: "ROOM", subCategory: "EXTRA_PERSON", netMinor: 100_000, taxMinor: 12_000, balanceDeltaMinor: 112_000 }),
    e({ kind: "CHARGE", category: "FNB", netMinor: 200_000, taxMinor: 10_000, balanceDeltaMinor: 210_000 }),
    e({ kind: "CHARGE", category: "SPA", netMinor: 50_000, taxMinor: 9_000, balanceDeltaMinor: 59_000 }),
    e({ kind: "DISCOUNT", category: "ROOM", netMinor: -100_000, taxMinor: -12_000, balanceDeltaMinor: -112_000 }),
    e({ kind: "PAYMENT", balanceDeltaMinor: -300_000, postedAt: at("2026-10-10") }), // advance
    e({ kind: "PAYMENT", balanceDeltaMinor: -500_000, postedAt: at("2026-10-14") }),
    e({ kind: "REFUND", balanceDeltaMinor: 50_000 }),
  ];
  it("splits charges, discounts and tax, and the parts add up to the bill", () => {
    const s = summarizeFolio(entries, at("2026-10-12"));
    expect(s).toMatchObject({
      roomMinor: 900_000, extraPersonMinor: 100_000, restaurantMinor: 200_000, otherServicesMinor: 50_000,
      discountsMinor: 100_000, taxMinor: 127_000, billedMinor: 1_277_000,
    });
    expect(s.roomMinor + s.extraPersonMinor + s.restaurantMinor + s.otherServicesMinor - s.discountsMinor + s.taxMinor).toBe(s.billedMinor);
  });
  it("separates advances, payments, refunds and the balance", () => {
    const s = summarizeFolio(entries, at("2026-10-12"));
    expect(s).toMatchObject({ advanceMinor: 300_000, paymentsMinor: 800_000, refundsMinor: 50_000, balanceMinor: 527_000 });
  });
  it("before check-in every payment is an advance", () => {
    expect(summarizeFolio(entries, null).advanceMinor).toBe(800_000);
  });
  it("a reversal (credit note) reduces the category it reverses", () => {
    const withCredit = [...entries, e({ kind: "REVERSAL", category: "FNB", netMinor: -200_000, taxMinor: -10_000, balanceDeltaMinor: -210_000 })];
    const s = summarizeFolio(withCredit, at("2026-10-12"));
    expect(s.restaurantMinor).toBe(0);
    expect(s.billedMinor).toBe(1_067_000);
  });
  it("is empty-safe", () => {
    expect(summarizeFolio([], null)).toMatchObject({ billedMinor: 0, balanceMinor: 0 });
  });
});
