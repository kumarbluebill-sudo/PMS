import { describe, expect, it } from "vitest";
import { calculateTax, type TaxRuleInput } from "./gst";
import { ACCOMMODATION_PRESETS, CHANGE_DATE, OWN_RULE_CATEGORIES, presetById } from "./gstPresets";

/** The presets as approved rules, so the engine can price with them. */
const approved = (): TaxRuleInput[] =>
  ACCOMMODATION_PRESETS.flatMap((p) => p.rules).map((r, i) => ({
    id: `r${i}`, category: r.category, sacCode: r.sacCode, treatment: r.treatment, rateBp: Math.round(r.ratePercent * 100), cessBp: 0,
    tariffMinMinor: r.tariffMinMinor ?? null, tariffMaxMinor: r.tariffMaxMinor ?? null, placeOfSupply: "PROPERTY_STATE",
    effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null, legalRef: r.legalRef, version: 1, status: "APPROVED",
  }));
const hotel: { supplierRegistered: boolean; supplierStateCode: string | null; recipientStateCode: string | null } = { supplierRegistered: true, supplierStateCode: "29", recipientStateCode: null };
const price = (tariffRupees: number, date: string, party = hotel, inclusive = false) =>
  calculateTax({ amountMinor: tariffRupees * 100, taxInclusive: inclusive, category: "ROOM", serviceDate: date, unitTariffMinor: tariffRupees * 100 }, party, approved());

// These expected figures are the engine's output for the rules above. They are NOT accountant-approved test cases:
// the hotel's accountant should confirm the rates and dates themselves before any rule is approved.
describe("accommodation presets (pending accountant sign-off)", () => {
  it("charges 5% up to and including ₹7,500 and 18% above it, from 22 September 2025", () => {
    const at = price(7500, CHANGE_DATE);
    expect(at.detail.rateBp).toBe(500);
    expect(at.taxMinor).toBe(37_500);
    expect(at.detail.cgstMinor + at.detail.sgstMinor).toBe(37_500);
    const above = price(7501, CHANGE_DATE);
    expect(above.detail.rateBp).toBe(1800);
    expect(above.taxMinor).toBe(135_018);
    expect(price(12_000, "2026-01-15").taxMinor).toBe(216_000);
  });
  it("switches on the effective date: the day before still uses the old slabs", () => {
    expect(price(5000, "2025-09-21").detail.rateBp).toBe(1200);
    expect(price(5000, "2025-09-22").detail.rateBp).toBe(500);
    expect(price(9000, "2025-09-21").detail.rateBp).toBe(1800);
    expect(price(1000, "2025-09-21").detail.treatment).toBe("EXEMPT");
    expect(price(1000, "2025-09-21").taxMinor).toBe(0);
    expect(price(1001, "2025-09-21").detail.rateBp).toBe(1200);
  });
  it("splits into CGST and SGST for accommodation, whose place of supply is the property state", () => {
    const intra = price(4000, "2026-02-01");
    expect(intra.detail).toMatchObject({ supplyType: "INTRA_STATE", igstMinor: 0, cgstMinor: 10_000, sgstMinor: 10_000 });
    const inter = price(4000, "2026-02-01", { supplierRegistered: true, supplierStateCode: "29", recipientStateCode: "27" });
    expect(inter.detail.supplyType).toBe("INTRA_STATE"); // place of supply defaults to the property's state for accommodation
  });
  it("handles inclusive prices: the gross stays fixed", () => {
    const r = price(5250, "2026-03-01", hotel, true);
    expect(r.grossMinor).toBe(525_000);
    expect(r.netMinor + r.taxMinor).toBe(525_000);
    expect(r.taxMinor).toBe(25_000);
  });
  it("covers every tariff exactly once on any date in range, with no gaps or overlaps", () => {
    for (const date of ["2019-10-01", "2024-04-01", "2025-09-21", "2025-09-22", "2030-01-01"]) {
      for (const t of [0.01, 500, 1000, 1000.01, 7499.99, 7500, 7500.01, 25_000, 100_000]) {
        expect(() => calculateTax({ amountMinor: Math.round(t * 100), taxInclusive: false, category: "ROOM", serviceDate: date, unitTariffMinor: Math.round(t * 100) }, hotel, approved()), `${date} ₹${t}`).not.toThrow();
      }
    }
  });
  it("is silent about every category it does not default, so those must be configured", () => {
    expect(() => calculateTax({ amountMinor: 50_000, taxInclusive: false, category: "FNB", serviceDate: "2026-01-01", unitTariffMinor: 50_000 }, hotel, approved())).toThrow(/No approved tax rule covers FNB/);
    expect(OWN_RULE_CATEGORIES.map((c) => c.category)).not.toContain("ROOM");
  });
  it("marks every preset rule for accountant review and keeps the preset ids stable", () => {
    for (const r of ACCOMMODATION_PRESETS.flatMap((p) => p.rules)) expect(r.legalRef).toContain("ACCOUNTANT REVIEW REQUIRED");
    expect(presetById("accommodation-2025")?.rules).toHaveLength(2);
    expect(presetById("nope")).toBeNull();
  });
});

describe("place of supply with a category the hotel configures itself", () => {
  it("charges IGST when the rule uses the recipient's state and it differs from the hotel's", () => {
    const rule: TaxRuleInput = { id: "f", category: "FNB", sacCode: "996331", treatment: "TAXABLE" as const, rateBp: 500, cessBp: 0, tariffMinMinor: null, tariffMaxMinor: null, placeOfSupply: "RECIPIENT_STATE", effectiveFrom: "2025-09-22", effectiveTo: null, legalRef: null, version: 1, status: "APPROVED" as const };
    const base = { amountMinor: 100_000, taxInclusive: false, category: "FNB", serviceDate: "2026-01-01", unitTariffMinor: 100_000 };
    const inter = calculateTax(base, { supplierRegistered: true, supplierStateCode: "29", recipientStateCode: "27" }, [rule]);
    expect(inter.detail).toMatchObject({ supplyType: "INTER_STATE", igstMinor: 5_000, cgstMinor: 0, sgstMinor: 0 });
    const intra = calculateTax(base, { supplierRegistered: true, supplierStateCode: "29", recipientStateCode: "29" }, [rule]);
    expect(intra.detail).toMatchObject({ supplyType: "INTRA_STATE", igstMinor: 0, cgstMinor: 2_500, sgstMinor: 2_500 });
  });
});
