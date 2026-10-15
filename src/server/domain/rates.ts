/**
 * Rate-plan pricing, pure and free of the database. Dates are YYYY-MM-DD; amounts are whole paise and pre-tax.
 *
 * Precedence when several plans apply to a night: highest priority, then the narrower date window, then the newer
 * plan. With no applicable plan the category's base rate ("Standard") is used. A plan's weekend rate applies on its
 * weekend days. A guest alone in the room gets the plan's single-occupancy rate when it has one.
 */
export type PlanRateLine = {
  roomTypeId: string;
  weekdayRateMinor: number;
  weekendRateMinor: number | null;
  singleOccupancyRateMinor: number | null;
  extraAdultRateMinor: number | null;
  extraChildRateMinor: number | null;
};

export type PlanInput = {
  id: string;
  name: string;
  code: string;
  active: boolean;
  priority: number;
  validFrom: string | null;
  validTo: string | null;
  weekendDays: number[];
  minStay: number | null;
  maxStay: number | null;
  createdAt: number;
  rates: PlanRateLine[];
};

export type NightRate = {
  date: string;
  rateMinor: number;
  planId: string | null;
  planName: string | null;
  basis: "BASE" | "WEEKDAY" | "WEEKEND" | "SINGLE";
};

export const MEAL_PLANS = ["ROOM_ONLY", "BREAKFAST", "HALF_BOARD", "FULL_BOARD"] as const;
export const MEAL_LABELS: Record<(typeof MEAL_PLANS)[number], string> = {
  ROOM_ONLY: "Room only", BREAKFAST: "Breakfast included", HALF_BOARD: "Half board", FULL_BOARD: "Full board",
};
export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const dayOfWeek = (d: string) => new Date(ms(d)).getUTCDay();
const span = (p: { validFrom: string | null; validTo: string | null }) =>
  p.validFrom && p.validTo ? ms(p.validTo) - ms(p.validFrom) : Number.POSITIVE_INFINITY;

/** Is the plan open on this date (active and inside its validity window)? */
export function planCovers(p: Pick<PlanInput, "active" | "validFrom" | "validTo">, date: string): boolean {
  return p.active && (!p.validFrom || p.validFrom <= date) && (!p.validTo || p.validTo >= date);
}

/** Does a stay of `nights` satisfy the plan's minimum and maximum stay? */
export function stayAllowed(p: Pick<PlanInput, "minStay" | "maxStay">, nights: number): boolean {
  return (p.minStay === null || nights >= p.minStay) && (p.maxStay === null || nights <= p.maxStay);
}

/** Orders plans best first: priority, then narrower window, then newer. */
export function byPrecedence(a: PlanInput, b: PlanInput): number {
  return b.priority - a.priority || span(a) - span(b) || b.createdAt - a.createdAt;
}

export type RateQuery = {
  roomTypeId: string;
  baseRateMinor: number;
  dates: string[];
  adults: number;
  children: number;
  plans: PlanInput[];
  /** Force one plan (the guest chose it); it must be open and linked or the base rate is used. */
  onlyPlanId?: string | null;
};

/** The rate charged for each night of a stay, and the plan that set it. */
export function effectiveNightRates(q: RateQuery): NightRate[] {
  const nights = q.dates.length;
  const eligible = q.plans
    .filter((p) => (q.onlyPlanId ? p.id === q.onlyPlanId : true) && stayAllowed(p, nights) && p.rates.some((r) => r.roomTypeId === q.roomTypeId))
    .sort(byPrecedence);
  return q.dates.map((date) => {
    const plan = eligible.find((p) => planCovers(p, date));
    if (!plan) return { date, rateMinor: q.baseRateMinor, planId: null, planName: null, basis: "BASE" as const };
    const line = plan.rates.find((r) => r.roomTypeId === q.roomTypeId)!;
    const weekend = plan.weekendDays.includes(dayOfWeek(date));
    if (q.adults === 1 && q.children === 0 && line.singleOccupancyRateMinor !== null) {
      return { date, rateMinor: line.singleOccupancyRateMinor, planId: plan.id, planName: plan.name, basis: "SINGLE" as const };
    }
    const useWeekend = weekend && line.weekendRateMinor !== null;
    return { date, rateMinor: useWeekend ? line.weekendRateMinor! : line.weekdayRateMinor, planId: plan.id, planName: plan.name, basis: useWeekend ? ("WEEKEND" as const) : ("WEEKDAY" as const) };
  });
}

/** Extra-person rates for a stay: the first applied plan's overrides, else the category's. */
export function effectiveExtras(
  nightRates: NightRate[], plans: PlanInput[], roomTypeId: string, base: { extraAdultRateMinor: number; extraChildRateMinor: number },
): { extraAdultRateMinor: number; extraChildRateMinor: number } {
  const id = nightRates.find((n) => n.planId)?.planId;
  const line = id ? plans.find((p) => p.id === id)?.rates.find((r) => r.roomTypeId === roomTypeId) : undefined;
  return {
    extraAdultRateMinor: line?.extraAdultRateMinor ?? base.extraAdultRateMinor,
    extraChildRateMinor: line?.extraChildRateMinor ?? base.extraChildRateMinor,
  };
}

const overlap = (a: { validFrom: string | null; validTo: string | null }, b: { validFrom: string | null; validTo: string | null }) =>
  (a.validTo === null || b.validFrom === null || a.validTo >= b.validFrom) && (b.validTo === null || a.validFrom === null || b.validTo >= a.validFrom);

export type PlanConflict = { otherId: string; otherName: string; roomTypeIds: string[] };

/**
 * Two active plans clash when they cover the same category on overlapping dates at the same priority, because then
 * nothing says which one wins. Different priorities are allowed on purpose (a seasonal plan over a standard one).
 */
export function findPlanConflicts(candidate: PlanInput, others: PlanInput[]): PlanConflict[] {
  if (!candidate.active) return [];
  const out: PlanConflict[] = [];
  for (const o of others) {
    if (o.id === candidate.id || !o.active || o.priority !== candidate.priority || !overlap(candidate, o)) continue;
    const shared = candidate.rates.map((r) => r.roomTypeId).filter((id) => o.rates.some((x) => x.roomTypeId === id));
    if (shared.length) out.push({ otherId: o.id, otherName: o.name, roomTypeIds: shared });
  }
  return out;
}

/** Frozen rates stored on a reservation when it is booked. */
export type RateSnapshot = {
  nightly?: Record<string, number>;
  extraAdultMinor?: number;
  extraChildMinor?: number;
  baseOccupancy?: number;
};

/** The nightly rate to post: the frozen night, else the booking's agreed rate, else the category's current base rate. */
export function postingRate(snapshot: RateSnapshot | null, night: string, agreedRateMinor: number | null, baseRateMinor: number): number {
  return snapshot?.nightly?.[night] ?? agreedRateMinor ?? baseRateMinor;
}
