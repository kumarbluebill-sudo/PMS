import { describe, expect, it } from "vitest";
import {
  addMonths, checkCoupon, checkLimit, DEFAULT_CONFIG, downgradeBlockers, effectivePrice, evaluate, financialYear, formatInvoiceNumber, hasFeature,
  isReadOnly, limitMessage, nextPeriod, planPrice, prorate, taxOn, usageLevel, type CouponLike, type PlanLike, type SubState,
} from "./subscription";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const plan = (over: Partial<PlanLike> = {}): PlanLike => ({
  code: "pro", name: "Professional", monthlyPriceMinor: 249_900, annualPriceMinor: null, annualDiscountBps: 1667,
  maxProperties: 1, maxRooms: 50, maxUsers: 10, maxStorageMb: null, maxIntegrations: 2, features: { whatsapp: true }, ...over,
});

describe("dates and prices", () => {
  it("adds months and keeps the last day where the day does not exist", () => {
    expect(addMonths(d("2026-01-31"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonths(d("2026-03-15"), 12).toISOString().slice(0, 10)).toBe("2027-03-15");
  });
  it("derives the annual price from the discount unless one is set", () => {
    expect(planPrice(plan(), "MONTHLY")).toBe(249_900);
    expect(planPrice(plan(), "ANNUAL")).toBe(Math.round((249_900 * 12 * (10_000 - 1667)) / 10_000));
    expect(planPrice(plan({ annualPriceMinor: 2_500_000 }), "ANNUAL")).toBe(2_500_000);
  });
  it("an override replaces the plan price, even when it is zero", () => {
    expect(effectivePrice(plan(), "MONTHLY", 0)).toBe(0);
    expect(effectivePrice(plan(), "MONTHLY", null)).toBe(249_900);
  });
  it("computes GST on the subscription fee", () => {
    expect(taxOn(249_900, 1800)).toBe(44_982);
  });
});

describe("proration", () => {
  it("credits unused days of the old plan and charges unused days of the new one", () => {
    // 30-day period, 15 days left
    const p = prorate({ oldPriceMinor: 99_900, newPriceMinor: 249_900, periodStart: d("2026-06-01"), periodEnd: d("2026-07-01"), now: d("2026-06-16") });
    expect(p.totalDays).toBe(30);
    expect(p.daysLeft).toBe(15);
    expect(p.creditMinor).toBe(Math.round((99_900 * 15) / 30));
    expect(p.chargeMinor).toBe(Math.round((249_900 * 15) / 30));
    expect(p.dueMinor).toBe(p.chargeMinor - p.creditMinor);
  });
  it("charges the full difference on day one and nothing on the last day", () => {
    const base = { oldPriceMinor: 100_000, newPriceMinor: 300_000, periodStart: d("2026-06-01"), periodEnd: d("2026-07-01") };
    expect(prorate({ ...base, now: d("2026-06-01") }).dueMinor).toBe(200_000);
    expect(prorate({ ...base, now: d("2026-07-01") }).dueMinor).toBe(0);
    expect(prorate({ ...base, now: d("2026-08-01") }).daysLeft).toBe(0);
  });
  it("never charges a negative amount", () => {
    const p = prorate({ oldPriceMinor: 300_000, newPriceMinor: 100_000, periodStart: d("2026-06-01"), periodEnd: d("2026-07-01"), now: d("2026-06-10") });
    expect(p.dueMinor).toBe(0);
  });
  it("does not depend on the time of day", () => {
    const a = prorate({ oldPriceMinor: 1, newPriceMinor: 30_000, periodStart: d("2026-06-01"), periodEnd: d("2026-07-01"), now: new Date("2026-06-16T01:00:00Z") });
    const b = prorate({ oldPriceMinor: 1, newPriceMinor: 30_000, periodStart: d("2026-06-01"), periodEnd: d("2026-07-01"), now: new Date("2026-06-16T23:59:00Z") });
    expect(a).toEqual(b);
  });
});

describe("coupons", () => {
  const c = (over: Partial<CouponLike> = {}): CouponLike => ({ code: "LAUNCH", kind: "PERCENT", value: 1000, months: 3, startsAt: null, endsAt: null, maxRedemptions: null, redeemed: 0, planCodes: [], active: true, ...over });
  const now = d("2026-06-10");
  it("takes a percentage or a fixed amount, never more than the bill", () => {
    expect(checkCoupon(c(), "pro", 249_900, now)).toEqual({ ok: true, discountMinor: 24_990 });
    expect(checkCoupon(c({ kind: "AMOUNT", value: 50_000 }), "pro", 249_900, now)).toEqual({ ok: true, discountMinor: 50_000 });
    expect(checkCoupon(c({ kind: "AMOUNT", value: 900_000 }), "pro", 249_900, now)).toEqual({ ok: true, discountMinor: 249_900 });
  });
  it("rejects missing, inactive, early, expired, used-up and ineligible coupons", () => {
    expect(checkCoupon(null, "pro", 1, now).ok).toBe(false);
    expect(checkCoupon(c({ active: false }), "pro", 1, now).ok).toBe(false);
    expect(checkCoupon(c({ startsAt: d("2026-07-01") }), "pro", 1, now).ok).toBe(false);
    expect(checkCoupon(c({ endsAt: d("2026-06-10") }), "pro", 1, now).ok).toBe(false);
    expect(checkCoupon(c({ maxRedemptions: 5, redeemed: 5 }), "pro", 1, now).ok).toBe(false);
    expect(checkCoupon(c({ planCodes: ["growth"] }), "pro", 1, now).ok).toBe(false);
    expect(checkCoupon(c({ planCodes: ["pro"] }), "pro", 1, now).ok).toBe(true);
  });
});

describe("limits and features", () => {
  it("allows up to the limit and refuses past it", () => {
    expect(checkLimit(plan(), "rooms", 49).ok).toBe(true);
    expect(checkLimit(plan(), "rooms", 50).ok).toBe(false);
    expect(checkLimit(plan(), "rooms", 45, 6).ok).toBe(false);
    expect(checkLimit(plan(), "rooms", 45, 5).ok).toBe(true);
  });
  it("treats a null limit as unlimited", () => {
    expect(checkLimit(plan({ maxRooms: null }), "rooms", 100_000).ok).toBe(true);
    expect(usageLevel(5000, null)).toBe("unlimited");
  });
  it("says what to do", () => {
    expect(limitMessage("Starter", "rooms", 15)).toBe("Your Starter plan allows 15 rooms. Upgrade your plan to add more.");
    expect(limitMessage("Starter", "properties", 1)).toBe("Your Starter plan allows 1 property. Upgrade your plan to add more.");
  });
  it("warns at 90% and again when full", () => {
    expect(usageLevel(44, 50)).toBe("ok");
    expect(usageLevel(45, 50)).toBe("near");
    expect(usageLevel(50, 50)).toBe("full");
  });
  it("reads features as off unless set to true", () => {
    expect(hasFeature(plan(), "whatsapp")).toBe(true);
    expect(hasFeature(plan(), "channel_manager")).toBe(false);
    expect(hasFeature({ features: null }, "whatsapp")).toBe(false);
  });
  it("lists what to reduce before a downgrade", () => {
    const small = plan({ name: "Starter", maxRooms: 15, maxUsers: 3, maxProperties: 1 });
    const out = downgradeBlockers({ properties: 1, rooms: 22, users: 2, storage: 0, integrations: 0 }, small);
    expect(out).toEqual(["Starter allows 15 rooms and you have 22. Reduce this by 7 first."]);
    expect(downgradeBlockers({ properties: 1, rooms: 10, users: 2, storage: 0, integrations: 0 }, small)).toEqual([]);
  });
});

describe("status machine", () => {
  const base: SubState = { status: "ACTIVE", periodEnd: d("2026-07-01"), trialEndsAt: null, graceEndsAt: null, cancelAtPeriodEnd: false, priceOverrideMinor: null, hasOpenInvoice: false };
  const cfg = DEFAULT_CONFIG; // grace 7, lead 7, expire after 60
  it("issues the renewal invoice a week ahead and moves to payment due", () => {
    expect(evaluate(base, d("2026-06-20"), cfg).issueRenewal).toBe(false);
    const e = evaluate(base, d("2026-06-24"), cfg);
    expect(e).toMatchObject({ status: "PAYMENT_DUE", issueRenewal: true, notice: "RENEWAL_UPCOMING" });
  });
  it("does not issue a second renewal invoice when one is open", () => {
    expect(evaluate({ ...base, hasOpenInvoice: true }, d("2026-06-25"), cfg).issueRenewal).toBe(false);
  });
  it("goes past due when the period ends unpaid, then suspended after the grace days, then expired", () => {
    const due = { ...base, status: "PAYMENT_DUE" as const, hasOpenInvoice: true };
    expect(evaluate(due, d("2026-06-30"), cfg).status).toBe("PAYMENT_DUE");
    const past = evaluate(due, d("2026-07-01"), cfg);
    expect(past.status).toBe("PAST_DUE");
    expect(past.graceEndsAt?.toISOString().slice(0, 10)).toBe("2026-07-08");
    const pd = { ...due, status: "PAST_DUE" as const, graceEndsAt: past.graceEndsAt };
    expect(evaluate(pd, d("2026-07-07"), cfg).status).toBe("PAST_DUE");
    expect(evaluate(pd, d("2026-07-08"), cfg)).toMatchObject({ status: "SUSPENDED", notice: "SUSPENDED" });
    const sus = { ...pd, status: "SUSPENDED" as const };
    expect(evaluate(sus, d("2026-09-05"), cfg).status).toBe("SUSPENDED");
    expect(evaluate(sus, d("2026-09-06"), cfg).status).toBe("EXPIRED");
  });
  it("running the same day twice changes nothing", () => {
    const once = evaluate(base, d("2026-06-25"), cfg);
    const again = evaluate({ ...base, status: once.status, hasOpenInvoice: true }, d("2026-06-25"), cfg);
    expect(again.status).toBe(once.status);
    expect(again.issueRenewal).toBe(false);
  });
  it("cancel at period end ends the subscription instead of renewing", () => {
    expect(evaluate({ ...base, cancelAtPeriodEnd: true }, d("2026-06-25"), cfg).status).toBe("ACTIVE");
    expect(evaluate({ ...base, cancelAtPeriodEnd: true }, d("2026-07-01"), cfg)).toMatchObject({ status: "CANCELLED" });
  });
  it("a trial reminds in the last days and expires at the end", () => {
    const t: SubState = { ...base, status: "TRIAL", periodEnd: null, trialEndsAt: d("2026-06-15") };
    expect(evaluate(t, d("2026-06-01"), cfg).notice).toBeNull();
    expect(evaluate(t, d("2026-06-12"), cfg).notice).toBe("TRIAL_ENDING");
    expect(evaluate(t, d("2026-06-15"), cfg).status).toBe("EXPIRED");
  });
  it("founding customers with no period end and zero price never change", () => {
    expect(evaluate({ ...base, periodEnd: null, priceOverrideMinor: 0 }, d("2030-01-01"), cfg).status).toBe("ACTIVE");
    expect(evaluate({ ...base, priceOverrideMinor: 0 }, d("2026-06-30"), cfg).issueRenewal).toBe(false);
  });
  it("read-only states block writes; past due only when the setting says so", () => {
    for (const s of ["SUSPENDED", "EXPIRED", "CANCELLED"] as const) expect(isReadOnly(s)).toBe(true);
    for (const s of ["TRIAL", "ACTIVE", "PAYMENT_DUE"] as const) expect(isReadOnly(s)).toBe(false);
    expect(isReadOnly("PAST_DUE")).toBe(false);
    expect(isReadOnly("PAST_DUE", { pastDueReadOnly: true })).toBe(true);
  });
});

describe("periods and invoice numbers", () => {
  it("renews from the old end date, but a late payment starts today", () => {
    expect(nextPeriod(d("2026-07-01"), d("2026-06-28"), "MONTHLY").start.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(nextPeriod(d("2026-07-01"), d("2026-07-10"), "MONTHLY").start.toISOString().slice(0, 10)).toBe("2026-07-10");
    expect(nextPeriod(null, d("2026-07-10"), "ANNUAL").end.toISOString().slice(0, 10)).toBe("2027-07-10");
  });
  it("numbers the provider's invoices by financial year", () => {
    expect(financialYear(d("2026-03-31"))).toBe("2025-26");
    expect(financialYear(d("2026-04-01"))).toBe("2026-27");
    expect(formatInvoiceNumber("MKS", "2026-27", 12)).toBe("MKS/2026-27/00012");
  });
});
