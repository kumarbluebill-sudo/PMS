import type { Plan, Prisma, PrismaClient, Subscription } from "@prisma/client";
import { z } from "zod";
import { authorize, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import {
  addDays, checkCoupon, checkLimit, couponDiscount, DEFAULT_CONFIG, downgradeBlockers, effectivePrice, financialYear, formatInvoiceNumber, hasFeature, limitMessage,
  nextPeriod, periodEndFor, planPrice, prorate, startOfDay, taxOn, usageLevel,
  type FeatureKey, type Interval, type PlatformConfig, type Resource, type SubStatus,
} from "@/server/domain/subscription";
import { AppError } from "@/server/errors";
import { audit } from "./audit";

type Tx = Prisma.TransactionClient;
export type PlatformActor = { userId: string; requestId: string };

// ---------- platform settings ----------
export const SETTING_DEFAULTS = {
  "saas.legalName": "MK Solutions",
  "saas.gstin": "",
  "saas.address": "",
  "saas.stateCode": "",
  "saas.gstBps": 1800,
  "saas.invoicePrefix": "MKS",
  "saas.paymentInstructions": "",
  "saas.salesEmail": "",
  "saas.defaultTrialDays": 14,
  "saas.defaultPlanCode": "professional",
  "saas.graceDays": 7,
  "saas.renewalLeadDays": 7,
  "saas.expireAfterSuspendedDays": 60,
  "saas.pastDueReadOnly": false,
} as const;
export type PlatformSettings = { -readonly [K in keyof typeof SETTING_DEFAULTS]: (typeof SETTING_DEFAULTS)[K] extends number ? number : (typeof SETTING_DEFAULTS)[K] extends boolean ? boolean : string };

export async function platformSettings(tx: Tx): Promise<PlatformSettings> {
  const rows = await tx.platformSetting.findMany();
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS && typeof r.value === typeof SETTING_DEFAULTS[r.key as keyof typeof SETTING_DEFAULTS]) out[r.key] = r.value;
  return out as PlatformSettings;
}
export const configOf = (s: PlatformSettings): PlatformConfig => ({
  graceDays: s["saas.graceDays"], renewalLeadDays: s["saas.renewalLeadDays"], expireAfterSuspendedDays: s["saas.expireAfterSuspendedDays"], pastDueReadOnly: s["saas.pastDueReadOnly"],
}) satisfies PlatformConfig;
void DEFAULT_CONFIG;

// ---------- reading ----------
export async function subscriptionOf(tx: Tx, tenantId: string) {
  const sub = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: true, coupon: true } });
  return sub;
}

/** What a hotel uses today, counted against its plan's limits. Storage and integrations are not used yet, so they read zero. */
export async function usageCounts(tx: Tx, tenantId: string): Promise<Record<Resource, number>> {
  const properties = await tx.property.count({ where: { tenantId, status: { not: "ARCHIVED" } } });
  const rooms = await tx.room.count({ where: { tenantId, active: true } });
  const users = await tx.membership.count({ where: { tenantId, active: true } });
  return { properties, rooms, users, storage: 0, integrations: 0 };
}

/**
 * Refuses a create that would take the hotel past its plan. Called inside the creating transaction, so two requests
 * cannot both slip under the limit. A hotel with no subscription row (none exists in practice) is not limited.
 */
export async function assertWithinPlan(tx: Tx, tenantId: string, resource: Resource, adding = 1, pendingInvites = 0) {
  const sub = await subscriptionOf(tx, tenantId);
  if (!sub) return;
  const usage = await usageCounts(tx, tenantId);
  const current = usage[resource] + (resource === "users" ? pendingInvites : 0);
  const c = checkLimit(sub.plan, resource, current, adding);
  if (!c.ok && c.limit != null) throw new AppError("PLAN_LIMIT", limitMessage(sub.plan.name, resource, c.limit));
}
export async function assertFeature(tx: Tx, tenantId: string, key: FeatureKey, label: string) {
  const sub = await subscriptionOf(tx, tenantId);
  if (!sub) return;
  if (!hasFeature(sub.plan, key)) throw new AppError("PLAN_LIMIT", `${label} is not included in your ${sub.plan.name} plan. Upgrade your plan to use it.`);
}

// ---------- invoices and events ----------
async function event(tx: Tx, sub: Pick<Subscription, "id" | "tenantId">, type: string, detail: Prisma.InputJsonValue = {}, actorId?: string | null) {
  await tx.subscriptionEvent.create({ data: { tenantId: sub.tenantId, subscriptionId: sub.id, type, detail, actorId: actorId ?? null } });
}

async function nextInvoiceNumber(tx: Tx, prefix: string, now: Date) {
  const fy = financialYear(now);
  const key = `invoice:${prefix}:${fy}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO platform_counters ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = platform_counters."value" + 1
    RETURNING "value"`;
  return formatInvoiceNumber(prefix, fy, rows[0].value);
}

type Line = { description: string; amountMinor: number };
const intervalWord = (i: Interval) => (i === "ANNUAL" ? "annual" : "monthly");
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Applies the effect of a fully paid invoice to its subscription. */
async function applyPaid(tx: Tx, invoiceId: string, now: Date, actorId: string | null) {
  const inv = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: inv.subscriptionId } });
  if (inv.kind === "UPGRADE") {
    await event(tx, sub, "payment.upgrade_paid", { invoice: inv.number }, actorId);
    return;
  }
  let planId = sub.planId;
  let interval = sub.interval as Interval;
  if (inv.kind === "RENEWAL" && sub.pendingPlanId) { planId = sub.pendingPlanId; }
  if (inv.kind === "RENEWAL" && sub.pendingInterval) interval = sub.pendingInterval as Interval;
  const prevEnd = inv.kind === "RENEWAL" ? sub.periodEnd : null;
  const period = inv.periodStart && inv.periodEnd && inv.kind === "NEW" ? { start: inv.periodStart, end: inv.periodEnd } : nextPeriod(prevEnd, now, interval);
  const couponLeft = Math.max(0, sub.couponMonthsLeft - (sub.couponId ? 1 : 0));
  await tx.subscription.update({
    where: { id: sub.id },
    data: {
      status: "ACTIVE", planId, interval, periodStart: period.start, periodEnd: period.end, trialEndsAt: null, graceEndsAt: null,
      pendingPlanId: null, pendingInterval: null, couponMonthsLeft: couponLeft, ...(couponLeft === 0 && { couponId: null }),
    },
  });
  await event(tx, sub, "payment.activated", { invoice: inv.number, periodEnd: isoDay(period.end) }, actorId);
}

/** Creates an invoice for a subscription. A zero total (a full discount) is marked paid at once. */
export async function issueInvoice(
  tx: Tx,
  sub: Subscription & { plan: Plan },
  p: { kind: "NEW" | "RENEWAL" | "UPGRADE"; plan: Plan; interval: Interval; now: Date; periodStart: Date; periodEnd: Date; lines?: Line[]; useCoupon?: boolean; dueDate?: Date; actorId?: string | null },
) {
  const cfg = await platformSettings(tx);
  let lines = p.lines;
  if (!lines) {
    const price = effectivePrice(p.plan, p.interval, sub.priceOverrideMinor);
    lines = [{ description: `${p.plan.name} plan, ${intervalWord(p.interval)} (${isoDay(p.periodStart)} to ${isoDay(p.periodEnd)})`, amountMinor: price }];
    if (p.useCoupon !== false && sub.couponId && sub.couponMonthsLeft > 0) {
      const coupon = await tx.coupon.findUnique({ where: { id: sub.couponId } });
      const off = coupon && coupon.active ? couponDiscount(coupon, p.plan.code, price) : 0;
      if (off > 0) lines.push({ description: `Coupon ${coupon!.code}`, amountMinor: -off });
    }
  }
  const net = Math.max(0, lines.reduce((a, l) => a + l.amountMinor, 0));
  const taxBps = cfg["saas.gstBps"];
  const tax = taxOn(net, taxBps);
  const gross = net + tax;
  const number = await nextInvoiceNumber(tx, cfg["saas.invoicePrefix"], p.now);
  const dueDate = p.dueDate ?? (p.kind === "RENEWAL" ? p.periodStart : addDays(p.now, p.kind === "UPGRADE" ? 3 : 7));
  const inv = await tx.subscriptionInvoice.create({
    data: {
      tenantId: sub.tenantId, subscriptionId: sub.id, number, kind: p.kind, lines, netMinor: net, taxBps, taxMinor: tax, grossMinor: gross,
      dueDate, periodStart: p.periodStart, periodEnd: p.periodEnd, issuedAt: p.now,
    },
  });
  await event(tx, sub, "invoice.issued", { number, kind: p.kind, grossMinor: gross }, p.actorId);
  if (gross === 0) {
    await tx.subscriptionInvoice.update({ where: { id: inv.id }, data: { status: "PAID", paidAt: p.now } });
    await applyPaid(tx, inv.id, p.now, p.actorId ?? null);
  }
  return inv;
}

/** The renewal invoice for the next period, priced on the plan and interval the hotel will have then. */
export async function issueRenewalInvoice(tx: Tx, subId: string, now: Date, actorId?: string | null) {
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subId }, include: { plan: true } });
  const plan = sub.pendingPlanId ? await tx.plan.findUniqueOrThrow({ where: { id: sub.pendingPlanId } }) : sub.plan;
  const interval = (sub.pendingInterval as Interval | null) ?? (sub.interval as Interval);
  const start = sub.periodEnd ?? startOfDay(now);
  const inv = await issueInvoice(tx, sub, { kind: "RENEWAL", plan, interval, now, periodStart: start, periodEnd: periodEndFor(start, interval), actorId });
  return inv;
}

// ---------- paying ----------
export const PAYMENT_METHODS = ["BANK_TRANSFER", "UPI", "CASH", "CHEQUE", "OTHER"] as const;
const paymentSchema = z.object({
  invoiceId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(120).default(""),
  idempotencyKey: z.string().min(8).max(100),
  note: z.string().trim().max(500).optional(),
});

/** Records money received against an invoice. Safe to repeat: the same idempotency key records one payment. */
export async function recordPaymentTx(tx: Tx, tenantId: string, input: unknown, now: Date, actorId: string | null) {
  const d = paymentSchema.parse(input);
  const dup = await tx.subscriptionPayment.findUnique({ where: { idempotencyKey: d.idempotencyKey } });
  if (dup) return { payment: dup, duplicate: true };
  const inv = await tx.subscriptionInvoice.findFirst({ where: { id: d.invoiceId, tenantId } });
  if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
  if (inv.status !== "OPEN") throw new AppError("CONFLICT", inv.status === "PAID" ? "This invoice is already paid." : "This invoice was cancelled.");
  const paid = await tx.subscriptionPayment.aggregate({ where: { invoiceId: inv.id, status: "SUCCEEDED" }, _sum: { amountMinor: true } });
  const outstanding = inv.grossMinor - (paid._sum.amountMinor ?? 0);
  if (d.amountMinor > outstanding) throw new AppError("VALIDATION", "The amount is more than is still owed on this invoice.");
  const payment = await tx.subscriptionPayment.create({
    data: { tenantId, invoiceId: inv.id, amountMinor: d.amountMinor, method: d.method, reference: d.reference, idempotencyKey: d.idempotencyKey, recordedBy: actorId, note: d.note ?? null },
  });
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: inv.subscriptionId } });
  await event(tx, sub, "payment.recorded", { invoice: inv.number, amountMinor: d.amountMinor, method: d.method }, actorId);
  if (d.amountMinor === outstanding) {
    await tx.subscriptionInvoice.update({ where: { id: inv.id }, data: { status: "PAID", paidAt: now, nextRetryAt: null } });
    await applyPaid(tx, inv.id, now, actorId);
  }
  return { payment, duplicate: false };
}

/** A payment attempt that did not go through: kept on record, and the next reminder date moves. */
export async function recordFailedPaymentTx(tx: Tx, tenantId: string, input: { invoiceId: string; reason: string; retryInDays?: number }, now: Date, actorId: string | null) {
  const inv = await tx.subscriptionInvoice.findFirst({ where: { id: input.invoiceId, tenantId } });
  if (!inv || inv.status !== "OPEN") throw new AppError("NOT_FOUND", "There is no open invoice to mark.");
  await tx.subscriptionInvoice.update({ where: { id: inv.id }, data: { attempts: { increment: 1 }, nextRetryAt: addDays(now, input.retryInDays ?? 3) } });
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: inv.subscriptionId } });
  await event(tx, sub, "payment.failed", { invoice: inv.number, reason: input.reason.slice(0, 300) }, actorId);
}

export async function voidInvoiceTx(tx: Tx, tenantId: string, invoiceId: string, reason: string, actorId: string | null) {
  const inv = await tx.subscriptionInvoice.findFirst({ where: { id: invoiceId, tenantId } });
  if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
  if (inv.status !== "OPEN") throw new AppError("CONFLICT", "Only an open invoice can be cancelled.");
  const paid = await tx.subscriptionPayment.count({ where: { invoiceId, status: "SUCCEEDED" } });
  if (paid > 0) throw new AppError("CONFLICT", "Part of this invoice has been paid. Record the rest instead of cancelling it.");
  await tx.subscriptionInvoice.update({ where: { id: invoiceId }, data: { status: "VOID" } });
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: inv.subscriptionId } });
  await event(tx, sub, "invoice.voided", { number: inv.number, reason }, actorId);
}

// ---------- starting ----------
/** Starts the free trial of a new hotel. The plan comes from the sign-up link, else the platform default. */
export async function startTrial(tx: Tx, tenantId: string, planCode: string | null | undefined, now = new Date()) {
  const cfg = await platformSettings(tx);
  const wanted = planCode ? await tx.plan.findFirst({ where: { code: planCode, active: true, customPricing: false } }) : null;
  const plan = wanted ?? (await tx.plan.findFirst({ where: { code: cfg["saas.defaultPlanCode"], active: true } })) ?? (await tx.plan.findFirst({ where: { active: true }, orderBy: { sortOrder: "asc" } }));
  if (!plan) return null;
  const days = plan.trialDays > 0 ? plan.trialDays : cfg["saas.defaultTrialDays"];
  const sub = await tx.subscription.create({
    data: { tenantId, planId: plan.id, interval: "MONTHLY", status: "TRIAL", trialEndsAt: addDays(now, days) },
  });
  await event(tx, sub, "trial.started", { plan: plan.code, days });
  return sub;
}

// ---------- the hotel's own view ----------
export async function subscriptionOverview(db: PrismaClient, ctx: Ctx, now = new Date()) {
  authorize(ctx, "settings.view");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const sub = await subscriptionOf(tx, ctx.tenantId);
    if (!sub) return null;
    const [usage, invoices, payments, events, plans, settings, pending] = [
      await usageCounts(tx, ctx.tenantId),
      await tx.subscriptionInvoice.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { issuedAt: "desc" }, take: 24 }),
      await tx.subscriptionPayment.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: "desc" }, take: 24 }),
      await tx.subscriptionEvent.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: "desc" }, take: 20 }),
      await tx.plan.findMany({ where: { active: true, isPublic: true }, orderBy: { sortOrder: "asc" } }),
      await platformSettings(tx),
      sub.pendingPlanId ? await tx.plan.findUnique({ where: { id: sub.pendingPlanId } }) : null,
    ];
    const levels = Object.fromEntries((["properties", "rooms", "users"] as Resource[]).map((r) => {
      const limit = r === "properties" ? sub.plan.maxProperties : r === "rooms" ? sub.plan.maxRooms : sub.plan.maxUsers;
      return [r, usageLevel(usage[r], limit)];
    })) as Record<"properties" | "rooms" | "users", ReturnType<typeof usageLevel>>;
    return {
      sub, plan: sub.plan, coupon: sub.coupon, usage, levels, invoices, payments, events, plans, pendingPlan: pending,
      price: effectivePrice(sub.plan, sub.interval as Interval, sub.priceOverrideMinor),
      payment: { instructions: settings["saas.paymentInstructions"], legalName: settings["saas.legalName"] },
      status: sub.status as SubStatus, now,
    };
  });
}

const changeSchema = z.object({ planCode: z.string().min(1).max(40), interval: z.enum(["MONTHLY", "ANNUAL"]) });
const OPEN_BLOCK = "Pay or ask us to cancel your open renewal invoice before changing plan.";

type ChangePlan = {
  mode: "SUBSCRIBE" | "UPGRADE" | "SCHEDULE";
  plan: Plan;
  interval: Interval;
  blockers: string[];
  dueMinor: number; taxMinor: number; grossMinor: number;
  creditMinor: number; daysLeft: number; totalDays: number;
  effective: string;
};

async function planChange(tx: Tx, tenantId: string, raw: unknown, now: Date): Promise<{ sub: Subscription & { plan: Plan }; change: ChangePlan }> {
  const d = changeSchema.parse(raw);
  const sub = await subscriptionOf(tx, tenantId);
  if (!sub) throw new AppError("NOT_FOUND", "No subscription found.");
  const target = await tx.plan.findFirst({ where: { code: d.planCode, active: true, isPublic: true } });
  if (!target) throw new AppError("NOT_FOUND", "That plan is not available.");
  if (target.customPricing) throw new AppError("VALIDATION", `${target.name} is priced for each customer. Contact sales to move to it.`);
  const cfg = await platformSettings(tx);
  const usage = await usageCounts(tx, tenantId);
  const blockers = downgradeBlockers(usage, target);
  const interval = d.interval as Interval;
  const current = sub.status as SubStatus;
  const gst = cfg["saas.gstBps"];
  const base = { plan: target, interval, blockers, creditMinor: 0, daysLeft: 0, totalDays: 0 };
  const money = (net: number) => ({ dueMinor: net, taxMinor: taxOn(net, gst), grossMinor: net + taxOn(net, gst) });

  if (current === "ACTIVE" || current === "PAYMENT_DUE") {
    const open = await tx.subscriptionInvoice.count({ where: { tenantId, status: "OPEN", kind: "RENEWAL" } });
    if (open > 0) throw new AppError("CONFLICT", OPEN_BLOCK);
    if (sub.plan.id === target.id && sub.interval === interval) throw new AppError("VALIDATION", "You are already on this plan.");
    const monthlyEq = (p: Plan, i: Interval) => planPrice(p, i) / (i === "ANNUAL" ? 12 : 1);
    const upgrade = sub.periodStart && sub.periodEnd && monthlyEq(target, interval) > monthlyEq(sub.plan, sub.interval as Interval) && target.id !== sub.plan.id;
    if (upgrade && sub.periodStart && sub.periodEnd) {
      const pr = prorate({
        oldPriceMinor: effectivePrice(sub.plan, sub.interval as Interval, sub.priceOverrideMinor),
        newPriceMinor: planPrice(target, sub.interval as Interval), periodStart: sub.periodStart, periodEnd: sub.periodEnd, now,
      });
      return { sub, change: { mode: "UPGRADE", ...base, ...money(pr.dueMinor), creditMinor: pr.creditMinor, daysLeft: pr.daysLeft, totalDays: pr.totalDays, effective: "now" } };
    }
    return { sub, change: { mode: "SCHEDULE", ...base, ...money(0), effective: sub.periodEnd ? `at your next renewal on ${isoDay(sub.periodEnd)}` : "at your next renewal" } };
  }
  // Trial, lapsed, suspended or cancelled: subscribing starts a new paid period today.
  const price = planPrice(target, interval);
  return { sub, change: { mode: "SUBSCRIBE", ...base, ...money(price), effective: "when your payment is recorded" } };
}

export async function previewPlanChange(db: PrismaClient, ctx: Ctx, raw: unknown, now = new Date()) {
  authorize(ctx, "settings.view");
  return withTenant(db, ctx.tenantId, async (tx) => (await planChange(tx, ctx.tenantId, raw, now)).change);
}

export async function changePlan(db: PrismaClient, ctx: Ctx, raw: unknown, now = new Date()) {
  authorize(ctx, "subscription.manage");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { sub, change } = await planChange(tx, ctx.tenantId, raw, now);
    if (change.blockers.length > 0 && change.mode !== "UPGRADE") throw new AppError("VALIDATION", change.blockers.join(" "));
    const target = change.plan;
    if (change.mode === "UPGRADE" && sub.periodStart && sub.periodEnd) {
      await tx.subscription.update({ where: { id: sub.id }, data: { planId: target.id, pendingPlanId: null, pendingInterval: change.interval === sub.interval ? null : change.interval } });
      const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
      const lines: Line[] = [{ description: `Upgrade to ${target.name} for the rest of this period (${change.daysLeft} of ${change.totalDays} days, after credit for the unused part of ${sub.plan.name})`, amountMinor: change.dueMinor }];
      if (change.dueMinor > 0) await issueInvoice(tx, fresh, { kind: "UPGRADE", plan: target, interval: sub.interval as Interval, now, periodStart: startOfDay(now), periodEnd: sub.periodEnd, lines, useCoupon: false });
      await event(tx, sub, "plan.upgraded", { from: sub.plan.code, to: target.code, dueMinor: change.dueMinor }, ctx.userId);
    } else if (change.mode === "SCHEDULE") {
      await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: target.id, pendingInterval: change.interval } });
      await event(tx, sub, "plan.change_scheduled", { to: target.code, interval: change.interval }, ctx.userId);
    } else {
      // Subscribe: cancel any older unpaid first invoice, move to the chosen plan and bill the first period.
      const stale = await tx.subscriptionInvoice.findMany({ where: { tenantId: ctx.tenantId, status: "OPEN", kind: { in: ["NEW", "RENEWAL"] } } });
      for (const s of stale) await voidInvoiceTx(tx, ctx.tenantId, s.id, "Replaced by a new plan choice", ctx.userId);
      await tx.subscription.update({ where: { id: sub.id }, data: { planId: target.id, interval: change.interval, pendingPlanId: null, pendingInterval: null, cancelAtPeriodEnd: false } });
      const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
      await issueInvoice(tx, fresh, { kind: "NEW", plan: target, interval: change.interval, now, periodStart: startOfDay(now), periodEnd: periodEndFor(now, change.interval), actorId: ctx.userId });
      await event(tx, sub, "plan.chosen", { to: target.code, interval: change.interval }, ctx.userId);
    }
    await audit(tx, ctx, { action: "subscription.change_plan", entityType: "Subscription", entityId: sub.id, after: { plan: target.code, interval: change.interval, mode: change.mode } });
    return change;
  });
}

export async function clearScheduledChange(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "subscription.manage");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const sub = await subscriptionOf(tx, ctx.tenantId);
    if (!sub) throw new AppError("NOT_FOUND", "No subscription found.");
    await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null, pendingInterval: null } });
    await event(tx, sub, "plan.change_cleared", {}, ctx.userId);
    await audit(tx, ctx, { action: "subscription.clear_change", entityType: "Subscription", entityId: sub.id });
  });
}

export async function cancelSubscription(db: PrismaClient, ctx: Ctx, reason: string) {
  authorize(ctx, "subscription.manage");
  const why = z.string().trim().min(3, "Tell us why you are cancelling.").max(500).parse(reason);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const sub = await subscriptionOf(tx, ctx.tenantId);
    if (!sub) throw new AppError("NOT_FOUND", "No subscription found.");
    if (sub.status !== "ACTIVE" && sub.status !== "PAYMENT_DUE") throw new AppError("CONFLICT", sub.status === "TRIAL" ? "You are on a trial. It ends on its own if you do not subscribe." : "This subscription is not running, so there is nothing to cancel.");
    if (sub.cancelAtPeriodEnd) throw new AppError("CONFLICT", "Cancellation is already set.");
    const renewals = await tx.subscriptionInvoice.findMany({ where: { tenantId: ctx.tenantId, status: "OPEN", kind: "RENEWAL" } });
    for (const r of renewals) await voidInvoiceTx(tx, ctx.tenantId, r.id, "Subscription set to cancel", ctx.userId);
    await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, status: "ACTIVE", pendingPlanId: null, pendingInterval: null } });
    await event(tx, sub, "subscription.cancel_requested", { reason: why }, ctx.userId);
    await audit(tx, ctx, { action: "subscription.cancel", entityType: "Subscription", entityId: sub.id, reason: why });
  });
}

/** Undo a cancellation made earlier in the period. A lapsed subscription is renewed by choosing a plan instead. */
export async function resumeSubscription(db: PrismaClient, ctx: Ctx, now = new Date()) {
  authorize(ctx, "subscription.manage");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const sub = await subscriptionOf(tx, ctx.tenantId);
    if (!sub) throw new AppError("NOT_FOUND", "No subscription found.");
    if (!sub.cancelAtPeriodEnd || sub.status !== "ACTIVE") throw new AppError("CONFLICT", "There is no pending cancellation to undo.");
    await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
    await event(tx, sub, "subscription.resumed", {}, ctx.userId);
    await audit(tx, ctx, { action: "subscription.resume", entityType: "Subscription", entityId: sub.id });
    void now;
  });
}

/** Attaches a coupon to the next invoices. One coupon at a time; it must suit the current plan. */
export async function applyCouponCode(db: PrismaClient, ctx: Ctx, code: string, now = new Date()) {
  authorize(ctx, "subscription.manage");
  const c = z.string().trim().toUpperCase().min(2).max(40).parse(code);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const sub = await subscriptionOf(tx, ctx.tenantId);
    if (!sub) throw new AppError("NOT_FOUND", "No subscription found.");
    if (sub.couponId && sub.couponMonthsLeft > 0) throw new AppError("CONFLICT", "A coupon is already applied.");
    const coupon = await tx.coupon.findUnique({ where: { code: c } });
    const chk = checkCoupon(coupon, sub.plan.code, planPrice(sub.plan, sub.interval as Interval), now);
    if (!chk.ok) throw new AppError("VALIDATION", chk.reason);
    // Count the use only if no one else took the last one while we checked.
    const taken = await tx.coupon.updateMany({ where: { id: coupon!.id, ...(coupon!.maxRedemptions != null && { redeemed: { lt: coupon!.maxRedemptions } }) }, data: { redeemed: { increment: 1 } } });
    if (taken.count === 0) throw new AppError("VALIDATION", "This coupon has been used the maximum number of times.");
    await tx.subscription.update({ where: { id: sub.id }, data: { couponId: coupon!.id, couponMonthsLeft: coupon!.months } });
    await event(tx, sub, "coupon.applied", { code: c }, ctx.userId);
    await audit(tx, ctx, { action: "subscription.coupon", entityType: "Subscription", entityId: sub.id, after: { code: c } });
    return { code: c, months: coupon!.months, kind: coupon!.kind, value: coupon!.value };
  });
}

/** Everything the invoice PDF needs, for the owner of the subscription. */
export async function getSubscriptionInvoice(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "settings.view");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const inv = await tx.subscriptionInvoice.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
    const tenant = await tx.$queryRaw<{ legalName: string }[]>`SELECT "legalName" FROM tenants WHERE id = ${ctx.tenantId}::uuid`;
    return { inv, settings: await platformSettings(tx), customer: tenant[0]?.legalName ?? "" };
  });
}
