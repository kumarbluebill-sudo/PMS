/** Charge per night for guests beyond what the base rate covers. Children are charged only when a child rate is set. */
export function extraPersonPerNight(p: {
  adults: number;
  children: number;
  baseOccupancy: number;
  extraAdultRateMinor: number;
  extraChildRateMinor: number;
}): number {
  const extraAdults = Math.max(0, p.adults - p.baseOccupancy);
  return extraAdults * p.extraAdultRateMinor + p.children * p.extraChildRateMinor;
}

export type SummaryEntry = {
  kind: string;
  category: string;
  subCategory: string | null;
  netMinor: number;
  taxMinor: number;
  balanceDeltaMinor: number;
  postedAt: Date;
};

export type FolioSummary = {
  roomMinor: number;
  extraPersonMinor: number;
  restaurantMinor: number;
  otherServicesMinor: number;
  /** Shown as a positive amount that was taken off. */
  discountsMinor: number;
  taxMinor: number;
  /** What the guest was billed, including tax and after discounts. */
  billedMinor: number;
  /** Payments received before check-in (all payments if the guest has not checked in). */
  advanceMinor: number;
  paymentsMinor: number;
  refundsMinor: number;
  balanceMinor: number;
};

/** The guest billing summary. All figures come from the append-only ledger. */
export function summarizeFolio(entries: readonly SummaryEntry[], checkedInAt: Date | null): FolioSummary {
  const s: FolioSummary = {
    roomMinor: 0, extraPersonMinor: 0, restaurantMinor: 0, otherServicesMinor: 0, discountsMinor: 0,
    taxMinor: 0, billedMinor: 0, advanceMinor: 0, paymentsMinor: 0, refundsMinor: 0, balanceMinor: 0,
  };
  for (const e of entries) {
    if (e.kind === "PAYMENT") {
      const paid = -e.balanceDeltaMinor;
      s.paymentsMinor += paid;
      if (!checkedInAt || e.postedAt < checkedInAt) s.advanceMinor += paid;
    } else if (e.kind === "REFUND") {
      s.refundsMinor += e.balanceDeltaMinor;
    } else if (e.kind === "DISCOUNT") {
      s.discountsMinor += -e.netMinor;
      s.taxMinor += e.taxMinor;
      s.billedMinor += e.balanceDeltaMinor;
    } else {
      // CHARGE and REVERSAL (a reversal carries negative amounts)
      if (e.category === "ROOM" && e.subCategory === "EXTRA_PERSON") s.extraPersonMinor += e.netMinor;
      else if (e.category === "ROOM") s.roomMinor += e.netMinor;
      else if (e.category === "FNB") s.restaurantMinor += e.netMinor;
      else s.otherServicesMinor += e.netMinor;
      s.taxMinor += e.taxMinor;
      s.billedMinor += e.balanceDeltaMinor;
    }
  }
  s.balanceMinor = s.billedMinor - s.paymentsMinor + s.refundsMinor;
  return s;
}
