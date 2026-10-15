/**
 * Subscription rules for the software provider's own billing. Pure functions: no database, no clock (the caller passes
 * `now`). All money is integer paise. Dates are compared as whole UTC days, so a charge never depends on the hour.
 */
export type SubStatus = "TRIAL" | "ACTIVE" | "PAYMENT_DUE" | "PAST_DUE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
export type Interval = "MONTHLY" | "ANNUAL";

export const STATUS_LABEL: Record<SubStatus, string> = {
  TRIAL: "Trial", ACTIVE: "Active", PAYMENT_DUE: "Payment due", PAST_DUE: "Past due", SUSPENDED: "Suspended", CANCELLED: "Cancelled", EXPIRED: "Expired",
};

/** Features a plan can switch on. The plan row stores a key to true/false map; a missing key means off. */
export const FEATURES = [
  { key: "reservations", label: "Reservations and room board" },
  { key: "front_desk", label: "Front desk check-in and check-out" },
  { key: "housekeeping", label: "Housekeeping and maintenance" },
  { key: "billing_gst", label: "Folios, GST invoices and credit notes" },
  { key: "reports_basic", label: "Standard reports" },
  { key: "email_confirmations", label: "Email confirmations" },
  { key: "data_export", label: "Full data export" },
  { key: "whatsapp", label: "WhatsApp messages" },
  { key: "reports_advanced", label: "Advanced reports and accounting" },
  { key: "rate_plans", label: "Rate plans and seasons" },
  { key: "custom_roles", label: "Custom roles and permissions" },
  { key: "multi_property", label: "More than one property" },
  { key: "channel_manager", label: "Channel manager (when available)" },
  { key: "integrations", label: "Integrations (when available)" },
  { key: "priority_support", label: "Priority support" },
  { key: "dedicated_support", label: "Dedicated account manager" },
] as const;
export type FeatureKey = (typeof FEATURES)[number]["key"];

export type Limits = { maxProperties: number | null; maxRooms: number | null; maxUsers: number | null; maxStorageMb: number | null; maxIntegrations: number | null };
export type PlanLike = Limits & {
  code: string;
  name: string;
  monthlyPriceMinor: number;
  annualPriceMinor: number | null;
  annualDiscountBps: number;
  customPricing?: boolean;
  features: unknown;
};
export type Resource = "properties" | "rooms" | "users" | "storage" | "integrations";
export const RESOURCE_NOUN: Record<Resource, { limit: keyof Limits; one: string; many: string }> = {
  properties: { limit: "maxProperties", one: "property", many: "properties" },
  rooms: { limit: "maxRooms", one: "room", many: "rooms" },
  users: { limit: "maxUsers", one: "user", many: "users" },
  storage: { limit: "maxStorageMb", one: "MB of storage", many: "MB of storage" },
  integrations: { limit: "maxIntegrations", one: "integration", many: "integrations" },
};

// ---------- dates (whole UTC days) ----------
const DAY = 86_400_000;
const dayNumber = (d: Date) => Math.floor(d.getTime() / DAY);
export const startOfDay = (d: Date) => new Date(dayNumber(d) * DAY);
export const daysBetween = (from: Date, to: Date) => dayNumber(to) - dayNumber(from);
export const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

/** Adds calendar months, keeping the day of month where it exists and using the month's last day where it does not. */
export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}
export const periodEndFor = (start: Date, interval: Interval) => addMonths(startOfDay(start), interval === "ANNUAL" ? 12 : 1);

// ---------- prices ----------
export function planPrice(plan: Pick<PlanLike, "monthlyPriceMinor" | "annualPriceMinor" | "annualDiscountBps">, interval: Interval): number {
  if (interval === "MONTHLY") return plan.monthlyPriceMinor;
  if (plan.annualPriceMinor != null) return plan.annualPriceMinor;
  return Math.round((plan.monthlyPriceMinor * 12 * (10_000 - plan.annualDiscountBps)) / 10_000);
}
/** What a subscription is charged per period: its own override if set, else the plan price. */
export const effectivePrice = (plan: PlanLike, interval: Interval, overrideMinor: number | null | undefined) =>
  overrideMinor != null ? overrideMinor : planPrice(plan, interval);

export const taxOn = (netMinor: number, taxBps: number) => Math.round((netMinor * taxBps) / 10_000);

/**
 * Upgrade mid-period. The unused part of the old plan is credited and the unused part of the new plan is charged, both
 * by whole days left, each rounded to the paisa. The result is never negative: a plan that costs the same or less is
 * not an upgrade and charges nothing.
 */
export function prorate(input: { oldPriceMinor: number; newPriceMinor: number; periodStart: Date; periodEnd: Date; now: Date }) {
  const total = Math.max(1, daysBetween(input.periodStart, input.periodEnd));
  const left = Math.min(total, Math.max(0, daysBetween(input.now, input.periodEnd)));
  const credit = Math.round((input.oldPriceMinor * left) / total);
  const charge = Math.round((input.newPriceMinor * left) / total);
  return { totalDays: total, daysLeft: left, creditMinor: credit, chargeMinor: charge, dueMinor: Math.max(0, charge - credit) };
}

// ---------- coupons ----------
export type CouponLike = {
  code: string; kind: string; value: number; months: number; startsAt: Date | null; endsAt: Date | null;
  maxRedemptions: number | null; redeemed: number; planCodes: string[]; active: boolean;
};
export type CouponCheck = { ok: true; discountMinor: number } | { ok: false; reason: string };

export function checkCoupon(c: CouponLike | null, planCode: string, amountMinor: number, now: Date): CouponCheck {
  if (!c || !c.active) return { ok: false, reason: "This coupon code is not valid." };
  if (c.startsAt && now < c.startsAt) return { ok: false, reason: "This coupon is not active yet." };
  if (c.endsAt && now >= c.endsAt) return { ok: false, reason: "This coupon has expired." };
  if (c.maxRedemptions != null && c.redeemed >= c.maxRedemptions) return { ok: false, reason: "This coupon has been used the maximum number of times." };
  if (c.planCodes.length > 0 && !c.planCodes.includes(planCode)) return { ok: false, reason: "This coupon does not apply to the chosen plan." };
  const raw = c.kind === "PERCENT" ? Math.round((amountMinor * c.value) / 10_000) : c.value;
  return { ok: true, discountMinor: Math.min(amountMinor, Math.max(0, raw)) };
}

/** The discount of a coupon already attached to a subscription: the redemption cap and dates were checked when it was attached. */
export function couponDiscount(c: Pick<CouponLike, "kind" | "value" | "planCodes">, planCode: string, amountMinor: number): number {
  if (c.planCodes.length > 0 && !c.planCodes.includes(planCode)) return 0;
  const raw = c.kind === "PERCENT" ? Math.round((amountMinor * c.value) / 10_000) : c.value;
  return Math.min(amountMinor, Math.max(0, raw));
}

// ---------- limits and features ----------
export const hasFeature = (plan: Pick<PlanLike, "features">, key: FeatureKey): boolean =>
  !!plan.features && typeof plan.features === "object" && (plan.features as Record<string, unknown>)[key] === true;

export const limitOf = (plan: Limits, r: Resource): number | null => plan[RESOURCE_NOUN[r].limit];

/** Can `adding` more of a resource be created when `current` already exist? null limit means unlimited. */
export function checkLimit(plan: Limits, r: Resource, current: number, adding = 1): { ok: boolean; limit: number | null; current: number } {
  const limit = limitOf(plan, r);
  return { ok: limit == null || current + adding <= limit, limit, current };
}
export function limitMessage(planName: string, r: Resource, limit: number): string {
  const n = RESOURCE_NOUN[r];
  return `Your ${planName} plan allows ${limit} ${limit === 1 ? n.one : n.many}. Upgrade your plan to add more.`;
}
export type UsageLevel = "ok" | "near" | "full" | "unlimited";
export function usageLevel(current: number, limit: number | null): UsageLevel {
  if (limit == null) return "unlimited";
  if (current >= limit) return "full";
  return current * 10 >= limit * 9 ? "near" : "ok";
}

/** Reasons a hotel cannot move to `to` today, written for the owner. Empty means the change is allowed. */
export function downgradeBlockers(usage: Record<Resource, number>, to: PlanLike): string[] {
  const out: string[] = [];
  for (const r of Object.keys(RESOURCE_NOUN) as Resource[]) {
    const limit = limitOf(to, r);
    if (limit != null && usage[r] > limit) {
      const n = RESOURCE_NOUN[r];
      out.push(`${to.name} allows ${limit} ${limit === 1 ? n.one : n.many} and you have ${usage[r]}. Reduce this by ${usage[r] - limit} first.`);
    }
  }
  return out;
}

// ---------- status ----------
export type PlatformConfig = {
  graceDays: number;
  renewalLeadDays: number;
  expireAfterSuspendedDays: number;
  pastDueReadOnly: boolean;
};
export const DEFAULT_CONFIG: PlatformConfig = { graceDays: 7, renewalLeadDays: 7, expireAfterSuspendedDays: 60, pastDueReadOnly: false };

/** Writes are refused in these states. Viewing, exporting and the subscription pages always work. */
export function isReadOnly(status: SubStatus, cfg: Pick<PlatformConfig, "pastDueReadOnly"> = DEFAULT_CONFIG): boolean {
  if (status === "SUSPENDED" || status === "EXPIRED" || status === "CANCELLED") return true;
  return status === "PAST_DUE" && cfg.pastDueReadOnly;
}

export type SubState = {
  status: SubStatus;
  periodEnd: Date | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  priceOverrideMinor: number | null;
  hasOpenInvoice: boolean;
};
export type Evaluation = {
  status: SubStatus;
  graceEndsAt: Date | null;
  issueRenewal: boolean;
  /** Set when the state changed or a reminder is due; used to send each email once. */
  notice: "TRIAL_ENDING" | "RENEWAL_UPCOMING" | "PAST_DUE" | "SUSPENDED" | "EXPIRED" | "CANCELLED" | null;
};

/**
 * Where a subscription should be now. Called by the daily job; calling it again on the same day changes nothing, which
 * keeps the job safe to repeat. A subscription with no period end (the founding customers) never changes.
 */
export function evaluate(s: SubState, now: Date, cfg: PlatformConfig = DEFAULT_CONFIG): Evaluation {
  const keep: Evaluation = { status: s.status, graceEndsAt: s.graceEndsAt, issueRenewal: false, notice: null };
  switch (s.status) {
    case "TRIAL": {
      if (!s.trialEndsAt) return keep;
      if (now >= s.trialEndsAt) return { ...keep, status: "EXPIRED", notice: "EXPIRED" };
      return { ...keep, notice: daysBetween(now, s.trialEndsAt) <= 3 ? "TRIAL_ENDING" : null };
    }
    case "ACTIVE": {
      if (!s.periodEnd) return keep;
      if (s.cancelAtPeriodEnd) return now >= s.periodEnd ? { ...keep, status: "CANCELLED", notice: "CANCELLED" } : keep;
      if (s.priceOverrideMinor === 0) return keep; // nothing to bill
      if (daysBetween(now, s.periodEnd) <= cfg.renewalLeadDays) {
        return { ...keep, status: "PAYMENT_DUE", issueRenewal: !s.hasOpenInvoice, notice: "RENEWAL_UPCOMING" };
      }
      return keep;
    }
    case "PAYMENT_DUE": {
      if (!s.periodEnd) return keep;
      if (now < s.periodEnd) return keep;
      if (s.cancelAtPeriodEnd) return { ...keep, status: "CANCELLED", notice: "CANCELLED" };
      return { ...keep, status: "PAST_DUE", graceEndsAt: addDays(s.periodEnd, cfg.graceDays), notice: "PAST_DUE" };
    }
    case "PAST_DUE": {
      if (s.graceEndsAt && now >= s.graceEndsAt) return { ...keep, status: "SUSPENDED", notice: "SUSPENDED" };
      return keep;
    }
    case "SUSPENDED": {
      if (s.graceEndsAt && now >= addDays(s.graceEndsAt, cfg.expireAfterSuspendedDays)) return { ...keep, status: "EXPIRED", notice: "EXPIRED" };
      return keep;
    }
    default:
      return keep;
  }
}

/** The period after a payment: a renewal continues from the old end, a late or first payment starts today. */
export function nextPeriod(prevEnd: Date | null, now: Date, interval: Interval): { start: Date; end: Date } {
  const start = prevEnd && daysBetween(now, prevEnd) > 0 ? startOfDay(prevEnd) : startOfDay(now);
  return { start, end: periodEndFor(start, interval) };
}

/** Financial year label such as 2026-27 for the provider's invoice series (April to March). */
export function financialYear(d: Date): string {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}
export const formatInvoiceNumber = (prefix: string, fy: string, n: number) => `${prefix}/${fy}/${String(n).padStart(5, "0")}`;
