import { describe, expect, it } from "vitest";
import {
  calculateTax, divRound, financialYear, gstinCheckChar, selectRule, validateGstin, TaxEngineError,
  type TaxRuleInput,
} from "./gst";

// Test-only rules with ARBITRARY rates. They are fixtures for the engine, not tax advice.
const rule = (o: Partial<TaxRuleInput> = {}): TaxRuleInput => ({
  id: "r1", category: "ROOM", sacCode: "996311", treatment: "TAXABLE", rateBp: 1200, cessBp: 0,
  tariffMinMinor: null, tariffMaxMinor: null, placeOfSupply: "PROPERTY_STATE",
  effectiveFrom: "2020-01-01", effectiveTo: null, legalRef: "test", version: 1, status: "APPROVED", ...o,
});
const party = { supplierRegistered: true, supplierStateCode: "33", recipientStateCode: null };
const line = (amountMinor: number, o = {}) => ({
  amountMinor, taxInclusive: false, category: "ROOM", serviceDate: "2026-05-01", unitTariffMinor: amountMinor, ...o,
});

describe("divRound", () => {
  it("rounds half up and is symmetric for negatives", () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(4, 3)).toBe(1);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(0, 7)).toBe(0);
  });
  it("rejects non-integers", () => {
    expect(() => divRound(1.5, 2)).toThrow();
  });
});

describe("calculateTax", () => {
  it("tax-exclusive intra-state splits CGST/SGST equally", () => {
    const r = calculateTax(line(100000), party, [rule()]);
    expect(r).toMatchObject({ netMinor: 100000, taxMinor: 12000, grossMinor: 112000 });
    expect(r.detail).toMatchObject({ cgstMinor: 6000, sgstMinor: 6000, igstMinor: 0, supplyType: "INTRA_STATE" });
  });
  it("tax-inclusive keeps gross fixed and net = gross - tax", () => {
    const r = calculateTax(line(112000, { taxInclusive: true }), party, [rule()]);
    expect(r.grossMinor).toBe(112000);
    expect(r.netMinor + r.taxMinor).toBe(112000);
    expect(r.netMinor).toBe(100000);
  });
  it("uses IGST for inter-state supply (recipient state rule)", () => {
    const r = calculateTax(line(100000), { ...party, recipientStateCode: "27" }, [rule({ placeOfSupply: "RECIPIENT_STATE" })]);
    expect(r.detail).toMatchObject({ igstMinor: 12000, cgstMinor: 0, sgstMinor: 0, supplyType: "INTER_STATE", placeOfSupplyState: "27" });
  });
  it("accommodation-style PROPERTY_STATE rule ignores recipient state", () => {
    const r = calculateTax(line(100000), { ...party, recipientStateCode: "27" }, [rule()]);
    expect(r.detail.supplyType).toBe("INTRA_STATE");
  });
  it("adds cess", () => {
    const r = calculateTax(line(100000), party, [rule({ cessBp: 100 })]);
    expect(r.detail.cessMinor).toBe(1000);
    expect(r.grossMinor).toBe(113000);
  });
  it("components always sum to total tax and CGST equals SGST (rounding stress)", () => {
    for (let amt = 1; amt < 3000; amt += 7) {
      for (const inclusive of [false, true]) {
        for (const rateBp of [500, 1200, 1800, 2800]) {
          const r = calculateTax(line(amt, { taxInclusive: inclusive }), party, [rule({ rateBp })]);
          const d = r.detail;
          expect(d.cgstMinor).toBe(d.sgstMinor);
          expect(d.cgstMinor + d.sgstMinor + d.igstMinor + d.cessMinor).toBe(r.taxMinor);
          expect(r.netMinor + r.taxMinor).toBe(r.grossMinor);
          if (inclusive) expect(r.grossMinor).toBe(amt);
          else expect(r.netMinor).toBe(amt);
        }
      }
    }
  });
  it("negative amounts (discounts/reversals) mirror positives exactly", () => {
    const pos = calculateTax(line(33333), party, [rule({ rateBp: 1800 })]);
    const neg = calculateTax(line(-33333, { unitTariffMinor: 33333 }), party, [rule({ rateBp: 1800 })]);
    expect(neg.netMinor).toBe(-pos.netMinor);
    expect(neg.taxMinor).toBe(-pos.taxMinor);
    expect(neg.grossMinor).toBe(-pos.grossMinor);
  });
  it("exempt and nil-rated produce no tax but record the rule", () => {
    const r = calculateTax(line(50000), party, [rule({ treatment: "EXEMPT", rateBp: 0 })]);
    expect(r).toMatchObject({ taxMinor: 0, grossMinor: 50000 });
    expect(r.detail.ruleId).toBe("r1");
  });
  it("unregistered supplier charges no tax and needs no rule", () => {
    const r = calculateTax(line(50000), { ...party, supplierRegistered: false }, []);
    expect(r.taxMinor).toBe(0);
    expect(r.detail.basis).toBe("SUPPLIER_NOT_REGISTERED");
  });
  it("zero amount needs no rule", () => {
    expect(calculateTax(line(0), party, []).detail.basis).toBe("ZERO_AMOUNT");
  });
  it("refuses to guess when no rule exists or state code is missing", () => {
    expect(() => calculateTax(line(1000), party, [])).toThrow(TaxEngineError);
    expect(() => calculateTax(line(1000), { ...party, supplierStateCode: null }, [rule()])).toThrow(/state code/);
  });
  it("rejects fractional paise", () => {
    expect(() => calculateTax(line(10.5), party, [rule()])).toThrow();
  });
});

describe("selectRule", () => {
  const q = { category: "ROOM", serviceDate: "2026-05-01", unitTariffMinor: 500000 };
  it("ignores draft/retired rules", () => {
    expect(() => selectRule([rule({ status: "DRAFT" }), rule({ status: "RETIRED" })], q)).toThrow(/No approved/);
  });
  it("respects effective dates (from inclusive, to exclusive)", () => {
    const old = rule({ id: "old", effectiveTo: "2026-05-01", rateBp: 500 });
    const cur = rule({ id: "new", effectiveFrom: "2026-05-01", rateBp: 1200 });
    expect(selectRule([old, cur], q).id).toBe("new");
    expect(selectRule([old, cur], { ...q, serviceDate: "2026-04-30" }).id).toBe("old");
  });
  it("chooses by tariff band", () => {
    const low = rule({ id: "low", tariffMaxMinor: 100000 });
    const high = rule({ id: "high", tariffMinMinor: 100000 });
    expect(selectRule([low, high], { ...q, unitTariffMinor: 99999 }).id).toBe("low");
    expect(selectRule([low, high], { ...q, unitTariffMinor: 100000 }).id).toBe("high");
  });
  it("errors on overlapping approved rules", () => {
    expect(() => selectRule([rule({ id: "a" }), rule({ id: "b" })], q)).toThrow(/overlap/);
  });
});

describe("GSTIN and financial year", () => {
  it("validates the structure and check digit", () => {
    const first14 = "27AAPFU0939F1Z";
    const good = first14 + gstinCheckChar(first14);
    expect(validateGstin(good)).toEqual({ ok: true, stateCode: "27" });
    const bad = first14 + (good[14] === "A" ? "B" : "A");
    expect(validateGstin(bad)).toMatchObject({ ok: false });
    expect(validateGstin("123")).toMatchObject({ ok: false });
    expect(validateGstin("99AAPFU0939F1ZV")).toMatchObject({ ok: false });
  });
  it("matches a published sample GSTIN", () => {
    expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V");
  });
  it("computes the Indian financial year", () => {
    expect(financialYear("2026-04-01")).toBe("2627");
    expect(financialYear("2026-03-31")).toBe("2526");
    expect(financialYear("2027-01-15")).toBe("2627");
  });
});
