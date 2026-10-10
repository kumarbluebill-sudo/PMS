/**
 * GST calculation engine. Pure and deterministic: all money is integer minor units (paise),
 * all rates are basis points (1200 = 12.00%). No floating point is used.
 *
 * ROUNDING POLICY (documented, review with a GST professional):
 *  - Tax is computed per invoice line; each tax component is rounded half-up to the nearest paisa.
 *  - Intra-state: CGST and SGST are each computed at half the rate and are always equal.
 *  - Tax-inclusive amounts: gross is fixed; tax is derived from it and net = gross - tax.
 *  - No invoice-level round-off is applied; invoice totals are the sum of line values.
 *
 * Rules are data. This module never contains a hardcoded GST rate.
 */

export type Treatment = "TAXABLE" | "EXEMPT" | "NIL_RATED";

export type TaxRuleInput = {
  id: string;
  category: string;
  sacCode: string | null;
  treatment: Treatment;
  rateBp: number;
  cessBp: number;
  tariffMinMinor: number | null; // inclusive
  tariffMaxMinor: number | null; // exclusive
  placeOfSupply: "PROPERTY_STATE" | "RECIPIENT_STATE";
  effectiveFrom: string; // YYYY-MM-DD, inclusive
  effectiveTo: string | null; // exclusive
  legalRef: string | null;
  version: number;
  status: "DRAFT" | "APPROVED" | "RETIRED";
};

export type TaxDetail = {
  basis: "RULE" | "SUPPLIER_NOT_REGISTERED" | "ZERO_AMOUNT";
  ruleId: string | null;
  ruleVersion: number | null;
  legalRef: string | null;
  sacCode: string | null;
  treatment: Treatment | "NOT_REGISTERED";
  rateBp: number;
  cessBp: number;
  placeOfSupplyState: string | null;
  supplyType: "INTRA_STATE" | "INTER_STATE" | "NONE";
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  cessMinor: number;
  taxInclusive: boolean;
  serviceDate: string;
};

export type TaxResult = { netMinor: number; taxMinor: number; grossMinor: number; detail: TaxDetail };

export class TaxEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxEngineError";
  }
}

/** Half-up integer division for non-negative divisor; symmetric for negative numerators. */
export function divRound(n: number, d: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(d) || d <= 0) throw new TaxEngineError("Money maths requires integers.");
  const q = Math.floor(Math.abs(n) / d);
  const r = Math.abs(n) % d;
  const rounded = r * 2 >= d ? q + 1 : q;
  return n < 0 ? -rounded : rounded;
}

export function selectRule(
  rules: readonly TaxRuleInput[],
  q: { category: string; serviceDate: string; unitTariffMinor: number },
): TaxRuleInput {
  const hits = rules.filter(
    (r) =>
      r.status === "APPROVED" &&
      r.category === q.category &&
      r.effectiveFrom <= q.serviceDate &&
      (r.effectiveTo === null || q.serviceDate < r.effectiveTo) &&
      (r.tariffMinMinor === null || q.unitTariffMinor >= r.tariffMinMinor) &&
      (r.tariffMaxMinor === null || q.unitTariffMinor < r.tariffMaxMinor),
  );
  if (hits.length === 0) {
    throw new TaxEngineError(`No approved tax rule covers ${q.category} on ${q.serviceDate}. Ask an authorised user to approve one in Tax settings.`);
  }
  if (hits.length > 1) {
    throw new TaxEngineError(`Tax rules for ${q.category} overlap on ${q.serviceDate}; retire one so exactly one applies.`);
  }
  return hits[0];
}

export type CalcInput = {
  amountMinor: number; // per line, signed (negative for discounts/reversals)
  taxInclusive: boolean;
  category: string;
  serviceDate: string;
  unitTariffMinor: number; // used to match tariff bands
};

export type PartyContext = {
  supplierRegistered: boolean;
  supplierStateCode: string | null;
  recipientStateCode: string | null;
};

export function calculateTax(input: CalcInput, party: PartyContext, rules: readonly TaxRuleInput[]): TaxResult {
  if (!Number.isInteger(input.amountMinor) || !Number.isInteger(input.unitTariffMinor)) {
    throw new TaxEngineError("Amounts must be whole paise.");
  }
  const base = { taxInclusive: input.taxInclusive, serviceDate: input.serviceDate, cessBp: 0, rateBp: 0 };
  const zero = (extra: Partial<TaxDetail>): TaxResult => ({
    netMinor: input.amountMinor,
    taxMinor: 0,
    grossMinor: input.amountMinor,
    detail: {
      basis: "RULE", ruleId: null, ruleVersion: null, legalRef: null, sacCode: null, treatment: "EXEMPT",
      placeOfSupplyState: null, supplyType: "NONE", cgstMinor: 0, sgstMinor: 0, igstMinor: 0, cessMinor: 0,
      ...base, ...extra,
    },
  });

  if (input.amountMinor === 0) return zero({ basis: "ZERO_AMOUNT" });
  if (!party.supplierRegistered) return zero({ basis: "SUPPLIER_NOT_REGISTERED", treatment: "NOT_REGISTERED" });

  const rule = selectRule(rules, input);
  const rule0 = {
    ruleId: rule.id, ruleVersion: rule.version, legalRef: rule.legalRef, sacCode: rule.sacCode, treatment: rule.treatment,
  };
  if (rule.treatment !== "TAXABLE") return zero({ ...rule0 });

  if (!party.supplierStateCode) throw new TaxEngineError("Set the property's GST state code before charging tax.");
  const pos =
    rule.placeOfSupply === "RECIPIENT_STATE" && party.recipientStateCode ? party.recipientStateCode : party.supplierStateCode;
  const intra = pos === party.supplierStateCode;

  const { rateBp, cessBp } = rule;
  const gross = input.amountMinor;
  const sign = gross < 0 ? -1 : 1;
  const abs = Math.abs(gross);

  // Provisional net: for inclusive amounts derive it from gross, for exclusive it is the amount itself.
  const netForTax = input.taxInclusive ? divRound(abs * 10000, 10000 + rateBp + cessBp) : abs;
  let cgst = 0, sgst = 0, igst = 0;
  if (intra) {
    cgst = divRound(netForTax * rateBp, 20000);
    sgst = cgst;
  } else {
    igst = divRound(netForTax * rateBp, 10000);
  }
  const cess = divRound(netForTax * cessBp, 10000);
  const tax = cgst + sgst + igst + cess;

  const net = input.taxInclusive ? abs - tax : abs;
  const total = input.taxInclusive ? abs : abs + tax;
  return {
    netMinor: sign * net,
    taxMinor: sign * tax,
    grossMinor: sign * total,
    detail: {
      basis: "RULE", ...rule0, rateBp, cessBp, placeOfSupplyState: pos,
      supplyType: intra ? "INTRA_STATE" : "INTER_STATE",
      cgstMinor: sign * cgst, sgstMinor: sign * sgst, igstMinor: sign * igst, cessMinor: sign * cess,
      taxInclusive: input.taxInclusive, serviceDate: input.serviceDate,
    },
  };
}

// ---------- GSTIN / state helpers ----------

export const GST_STATES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Mod-36 checksum over the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export function validateGstin(gstin: string): { ok: true; stateCode: string } | { ok: false; reason: string } {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return { ok: false, reason: "GSTIN must be 15 characters in the standard format." };
  if (!GST_STATES[g.slice(0, 2)]) return { ok: false, reason: "GSTIN has an unknown state code." };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { ok: false, reason: "GSTIN check digit is invalid." };
  return { ok: true, stateCode: g.slice(0, 2) };
}

/** Indian financial year label (April to March), e.g. 2026-04-10 -> "2627". */
export function financialYear(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
}
