import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { RoleKey } from "@/server/auth/permissions";
import { withPlatform } from "@/server/db/withPlatform";
import { withTenant } from "@/server/db/withTenant";
import {
  addDays, effectivePrice, evaluate, periodEndFor, startOfDay, STATUS_LABEL, type Interval, type SubStatus,
} from "@/server/domain/subscription";
import { AppError } from "@/server/errors";
import { deliverEmail } from "./emailOutbox";
import {
  configOf, issueRenewalInvoice, platformSettings, recordFailedPaymentTx, recordPaymentTx, SETTING_DEFAULTS, voidInvoiceTx,
} from "./subscription";

type Tx = Prisma.TransactionClient;

/** Who is acting for the software provider. Built from a verified session by requirePlatform(); never from client input. */
export type PlatformCtx = { userId: string; role: RoleKey; requestId: string };
const WRITE_ROLES: RoleKey[] = ["PLATFORM_SUPER_ADMIN"];
const READ_ROLES: RoleKey[] = ["PLATFORM_SUPER_ADMIN", "SAAS_SUPPORT_ADMIN"];
/** What support staff may do besides reading: help a customer without changing prices, plans or money. */
const SUPPORT_ACTIONS = ["EXTEND_TRIAL", "NOTE"] as const;

export function assertPlatform(ctx: PlatformCtx, level: "read" | "write" = "read") {
  const ok = (level === "write" ? WRITE_ROLES : READ_ROLES).includes(ctx.role);
  if (!ok) throw new AppError("FORBIDDEN", "You do not have access to the platform console.");
}

const audit = (tx: Tx, p: PlatformCtx, tenantId: string, e: { action: string; entityType: string; entityId?: string; after?: Prisma.InputJsonValue; reason?: string }) =>
  tx.auditLog.create({ data: { tenantId, actorId: p.userId, requestId: p.requestId, ...e } });

// ---------- reading ----------
export type SubRow = {
  tenantId: string; hotel: string; planCode: string; planName: string; interval: string; status: SubStatus; periodEnd: Date | null; trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean; priceMinor: number; openInvoices: number; openMinor: number; note: string | null;
};

export async function listSubscriptions(db: PrismaClient, p: PlatformCtx, f: { status?: string; q?: string } = {}) {
  assertPlatform(p);
  const subs = await withPlatform(db, async (tx) => {
    const rows = await tx.subscription.findMany({ where: f.status ? { status: f.status } : {}, include: { plan: true }, orderBy: { createdAt: "desc" }, take: 500 });
    const open = await tx.subscriptionInvoice.groupBy({ by: ["tenantId"], where: { status: "OPEN" }, _count: true, _sum: { grossMinor: true } });
    return { rows, open: new Map(open.map((o) => [o.tenantId, o])) };
  });
  const tenants = await db.tenant.findMany({ where: { id: { in: subs.rows.map((r) => r.tenantId) } }, select: { id: true, displayName: true } });
  const names = new Map(tenants.map((t) => [t.id, t.displayName]));
  const q = f.q?.trim().toLowerCase();
  const out: SubRow[] = subs.rows
    .map((s) => ({
      tenantId: s.tenantId, hotel: names.get(s.tenantId) ?? "Unknown", planCode: s.plan.code, planName: s.plan.name, interval: s.interval, status: s.status as SubStatus,
      periodEnd: s.periodEnd, trialEndsAt: s.trialEndsAt, cancelAtPeriodEnd: s.cancelAtPeriodEnd, priceMinor: effectivePrice(s.plan, s.interval as Interval, s.priceOverrideMinor),
      openInvoices: subs.open.get(s.tenantId)?._count ?? 0, openMinor: subs.open.get(s.tenantId)?._sum.grossMinor ?? 0, note: s.note,
    }))
    .filter((r) => !q || r.hotel.toLowerCase().includes(q) || r.planCode.includes(q));
  return out;
}

export async function platformOverview(db: PrismaClient, p: PlatformCtx) {
  assertPlatform(p);
  const rows = await listSubscriptions(db, p);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  // Monthly recurring revenue counts paying, running subscriptions only (annual fees divided by twelve).
  const mrr = rows.filter((r) => r.status === "ACTIVE" || r.status === "PAYMENT_DUE" || r.status === "PAST_DUE").reduce((a, r) => a + (r.interval === "ANNUAL" ? Math.round(r.priceMinor / 12) : r.priceMinor), 0);
  const leads = await withPlatform(db, (tx) => tx.lead.count({ where: { status: "NEW" } }));
  return { total: rows.length, byStatus, mrrMinor: mrr, overdue: rows.filter((r) => r.status === "PAST_DUE" || r.status === "SUSPENDED"), newLeads: leads };
}

export async function subscriptionDetail(db: PrismaClient, p: PlatformCtx, tenantId: string) {
  assertPlatform(p);
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, displayName: true, legalName: true, createdAt: true } });
  if (!tenant) throw new AppError("NOT_FOUND", "Hotel not found.");
  return withTenant(db, tenantId, async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: true, coupon: true } });
    const usage = {
      properties: await tx.property.count({ where: { tenantId, status: { not: "ARCHIVED" } } }),
      rooms: await tx.room.count({ where: { tenantId, active: true } }),
      users: await tx.membership.count({ where: { tenantId, active: true } }),
    };
    return {
      tenant, sub, usage,
      invoices: await tx.subscriptionInvoice.findMany({ where: { tenantId }, orderBy: { issuedAt: "desc" }, take: 50 }),
      payments: await tx.subscriptionPayment.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50 }),
      events: await tx.subscriptionEvent.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50 }),
      plans: await tx.plan.findMany({ orderBy: { sortOrder: "asc" } }),
    };
  });
}

// ---------- actions on one hotel's subscription ----------
const reasonSchema = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(500);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ACTIVATE"), tenantId: z.string().uuid(), reason: reasonSchema }),
  z.object({ action: z.literal("EXTEND_TRIAL"), tenantId: z.string().uuid(), reason: reasonSchema, days: z.number().int().min(1).max(90) }),
  z.object({ action: z.literal("SUSPEND"), tenantId: z.string().uuid(), reason: reasonSchema }),
  z.object({ action: z.literal("CANCEL"), tenantId: z.string().uuid(), reason: reasonSchema }),
  z.object({ action: z.literal("CHANGE_PLAN"), tenantId: z.string().uuid(), reason: reasonSchema, planCode: z.string().min(1), interval: z.enum(["MONTHLY", "ANNUAL"]), priceOverrideMinor: z.number().int().min(0).nullable().default(null) }),
  z.object({ action: z.literal("NOTE"), tenantId: z.string().uuid(), reason: reasonSchema }),
]);
export type SubscriptionAction = z.input<typeof actionSchema>;

export async function adminAction(db: PrismaClient, p: PlatformCtx, raw: SubscriptionAction, now = new Date()) {
  assertPlatform(p);
  const a = actionSchema.parse(raw);
  if (!(SUPPORT_ACTIONS as readonly string[]).includes(a.action)) assertPlatform(p, "write");
  return withTenant(db, a.tenantId, async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { tenantId: a.tenantId }, include: { plan: true } });
    if (!sub) throw new AppError("NOT_FOUND", "This hotel has no subscription.");
    const ev = (type: string, detail: Prisma.InputJsonValue = {}) => tx.subscriptionEvent.create({ data: { tenantId: a.tenantId, subscriptionId: sub.id, type: `admin.${type}`, detail: { reason: a.reason, ...(detail as object) }, actorId: p.userId } });
    let data: Prisma.SubscriptionUncheckedUpdateInput = {};
    switch (a.action) {
      case "ACTIVATE": {
        const interval = sub.interval as Interval;
        const start = sub.periodEnd && sub.periodEnd > now ? (sub.periodStart ?? startOfDay(now)) : startOfDay(now);
        data = { status: "ACTIVE", periodStart: start, periodEnd: sub.periodEnd && sub.periodEnd > now ? sub.periodEnd : periodEndFor(start, interval), trialEndsAt: null, graceEndsAt: null, cancelAtPeriodEnd: false };
        break;
      }
      case "EXTEND_TRIAL": {
        const from = sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : startOfDay(now);
        data = { status: "TRIAL", trialEndsAt: addDays(from, a.days), graceEndsAt: null };
        break;
      }
      case "SUSPEND": data = { status: "SUSPENDED", graceEndsAt: startOfDay(now) }; break;
      case "CANCEL": data = { status: "CANCELLED", cancelAtPeriodEnd: false }; break;
      case "CHANGE_PLAN": {
        const plan = await tx.plan.findUnique({ where: { code: a.planCode } });
        if (!plan) throw new AppError("NOT_FOUND", "Plan not found.");
        data = { planId: plan.id, interval: a.interval, priceOverrideMinor: a.priceOverrideMinor, pendingPlanId: null, pendingInterval: null };
        break;
      }
      case "NOTE": data = { note: a.reason }; break;
    }
    await tx.subscription.update({ where: { id: sub.id }, data });
    await ev(a.action.toLowerCase(), a.action === "EXTEND_TRIAL" ? { days: a.days } : a.action === "CHANGE_PLAN" ? { plan: a.planCode, interval: a.interval, priceOverrideMinor: a.priceOverrideMinor } : {});
    await audit(tx, p, a.tenantId, { action: `platform.subscription.${a.action.toLowerCase()}`, entityType: "Subscription", entityId: sub.id, reason: a.reason });
    return tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  });
}

export async function adminRecordPayment(db: PrismaClient, p: PlatformCtx, tenantId: string, input: unknown, now = new Date()) {
  assertPlatform(p, "write");
  return withTenant(db, tenantId, async (tx) => {
    const r = await recordPaymentTx(tx, tenantId, input, now, p.userId);
    if (!r.duplicate) await audit(tx, p, tenantId, { action: "platform.payment.record", entityType: "SubscriptionPayment", entityId: r.payment.id, after: { amountMinor: r.payment.amountMinor, method: r.payment.method } });
    return r;
  });
}
export async function adminFailPayment(db: PrismaClient, p: PlatformCtx, tenantId: string, input: { invoiceId: string; reason: string; retryInDays?: number }, now = new Date()) {
  assertPlatform(p, "write");
  const reason = reasonSchema.parse(input.reason);
  return withTenant(db, tenantId, async (tx) => {
    await recordFailedPaymentTx(tx, tenantId, { ...input, reason }, now, p.userId);
    await audit(tx, p, tenantId, { action: "platform.payment.failed", entityType: "SubscriptionInvoice", entityId: input.invoiceId, reason });
  });
}
export async function adminVoidInvoice(db: PrismaClient, p: PlatformCtx, tenantId: string, invoiceId: string, reason: string) {
  assertPlatform(p, "write");
  const why = reasonSchema.parse(reason);
  return withTenant(db, tenantId, async (tx) => {
    await voidInvoiceTx(tx, tenantId, invoiceId, why, p.userId);
    await audit(tx, p, tenantId, { action: "platform.invoice.void", entityType: "SubscriptionInvoice", entityId: invoiceId, reason: why });
  });
}
export async function adminIssueRenewal(db: PrismaClient, p: PlatformCtx, tenantId: string, now = new Date()) {
  assertPlatform(p, "write");
  return withTenant(db, tenantId, async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new AppError("NOT_FOUND", "This hotel has no subscription.");
    const open = await tx.subscriptionInvoice.count({ where: { tenantId, status: "OPEN", kind: { in: ["NEW", "RENEWAL"] } } });
    if (open > 0) throw new AppError("CONFLICT", "There is already an open invoice.");
    const inv = await issueRenewalInvoice(tx, sub.id, now, p.userId);
    await audit(tx, p, tenantId, { action: "platform.invoice.issue", entityType: "SubscriptionInvoice", entityId: inv.id });
    return inv;
  });
}

// ---------- plans, add-ons, coupons, settings ----------
const limit = z.number().int().min(0).max(1_000_000).nullable();
const planSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,30}$/, "Code: 2 to 30 letters, numbers or dashes."),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(""),
  active: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  monthlyPriceMinor: z.number().int().min(0).max(100_000_000),
  annualPriceMinor: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  annualDiscountBps: z.number().int().min(0).max(10_000).default(1667),
  trialDays: z.number().int().min(0).max(90).default(14),
  customPricing: z.boolean().default(false),
  maxProperties: limit, maxRooms: limit, maxUsers: limit, maxStorageMb: limit, maxIntegrations: limit,
  features: z.record(z.string(), z.boolean()).default({}),
});
export async function upsertPlan(db: PrismaClient, p: PlatformCtx, raw: unknown) {
  assertPlatform(p, "write");
  const d = planSchema.parse(raw);
  const plan = await db.plan.upsert({ where: { code: d.code }, create: d, update: d });
  return plan;
}

const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, "Code: 3 to 30 letters, numbers, dashes or underscores."),
  description: z.string().trim().max(200).default(""),
  kind: z.enum(["PERCENT", "AMOUNT"]),
  value: z.number().int().positive(),
  months: z.number().int().min(1).max(36).default(1),
  startsAt: z.date().nullable().default(null),
  endsAt: z.date().nullable().default(null),
  maxRedemptions: z.number().int().positive().nullable().default(null),
  planCodes: z.array(z.string()).default([]),
  active: z.boolean().default(true),
}).refine((c) => c.kind !== "PERCENT" || c.value <= 10_000, { message: "A percentage cannot be more than 100%.", path: ["value"] });
export async function upsertCoupon(db: PrismaClient, p: PlatformCtx, raw: unknown) {
  assertPlatform(p, "write");
  const d = couponSchema.parse(raw);
  return db.coupon.upsert({ where: { code: d.code }, create: d, update: d });
}

const addonSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,30}$/),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(""),
  monthlyPriceMinor: z.number().int().min(0).max(100_000_000),
  active: z.boolean().default(true),
});
export async function upsertAddon(db: PrismaClient, p: PlatformCtx, raw: unknown) {
  assertPlatform(p, "write");
  const d = addonSchema.parse(raw);
  return db.planAddon.upsert({ where: { code: d.code }, create: d, update: d });
}

const settingSchemas = {
  "saas.legalName": z.string().trim().min(2).max(120),
  "saas.gstin": z.string().trim().toUpperCase().max(15),
  "saas.address": z.string().trim().max(300),
  "saas.stateCode": z.string().trim().max(2),
  "saas.gstBps": z.number().int().min(0).max(5000),
  "saas.invoicePrefix": z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, "Prefix: 2 to 8 letters or numbers."),
  "saas.paymentInstructions": z.string().trim().max(1000),
  "saas.salesEmail": z.string().trim().toLowerCase().max(200).refine((v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email address."),
  "saas.defaultTrialDays": z.number().int().min(0).max(90),
  "saas.defaultPlanCode": z.string().trim().min(1).max(40),
  "saas.graceDays": z.number().int().min(0).max(60),
  "saas.renewalLeadDays": z.number().int().min(1).max(60),
  "saas.expireAfterSuspendedDays": z.number().int().min(1).max(365),
  "saas.pastDueReadOnly": z.boolean(),
} satisfies Record<keyof typeof SETTING_DEFAULTS, z.ZodType>;

export async function savePlatformSettings(db: PrismaClient, p: PlatformCtx, raw: Record<string, unknown>) {
  assertPlatform(p, "write");
  for (const [key, value] of Object.entries(raw)) {
    const schema = (settingSchemas as Record<string, z.ZodType>)[key];
    if (!schema) throw new AppError("VALIDATION", `Unknown setting ${key}.`);
    const v = schema.parse(value) as Prisma.InputJsonValue;
    await db.platformSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
  }
}
export const readPlatformSettings = async (db: PrismaClient, p: PlatformCtx) => { assertPlatform(p); return db.$transaction((tx) => platformSettings(tx)); };

// ---------- leads ----------
export async function listLeads(db: PrismaClient, p: PlatformCtx) {
  assertPlatform(p);
  return db.lead.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
}
export async function setLeadStatus(db: PrismaClient, p: PlatformCtx, id: string, status: "NEW" | "CONTACTED" | "CLOSED") {
  assertPlatform(p, "write");
  await db.lead.update({ where: { id }, data: { status: z.enum(["NEW", "CONTACTED", "CLOSED"]).parse(status) } });
}

// ---------- the daily job ----------
const inr = (minor: number) => `Rs. ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

type Notice = NonNullable<ReturnType<typeof evaluate>["notice"]> | "PAYMENT_REMINDER";
function emailFor(notice: Notice, v: { hotel: string; plan: string; date: string; amount?: string; invoice?: string }) {
  const sign = "\n\nOpen Subscription & Plans in your account to see your invoices and payment details.\n\nMK Solutions";
  switch (notice) {
    case "TRIAL_ENDING": return { subject: `Your free trial ends on ${v.date}`, text: `Hello ${v.hotel},\n\nYour free trial ends on ${v.date}. Choose a plan before then to keep making changes. Your data stays safe either way.${sign}` };
    case "RENEWAL_UPCOMING": return { subject: `Renewal invoice ${v.invoice ?? ""} for your ${v.plan} plan`, text: `Hello ${v.hotel},\n\nYour ${v.plan} plan renews on ${v.date}. Invoice ${v.invoice ?? ""}${v.amount ? ` for ${v.amount}` : ""} is ready. Pay before ${v.date} to avoid any interruption.${sign}` };
    case "PAYMENT_REMINDER": return { subject: `Payment reminder: invoice ${v.invoice ?? ""}`, text: `Hello ${v.hotel},\n\nWe have not yet received payment for invoice ${v.invoice ?? ""}${v.amount ? ` (${v.amount})` : ""}. Please pay it, or reply to this email if you already have.${sign}` };
    case "PAST_DUE": return { subject: "Your subscription payment is overdue", text: `Hello ${v.hotel},\n\nYour subscription payment is overdue. Your account keeps working until ${v.date}; after that it becomes read-only (you can still view and export everything).${sign}` };
    case "SUSPENDED": return { subject: "Your account is now read-only", text: `Hello ${v.hotel},\n\nBecause payment was not received, your account is read-only. You can still view and export all your data, and nothing has been deleted. Pay the open invoice to restore full access.${sign}` };
    case "EXPIRED": return { subject: "Your subscription has expired", text: `Hello ${v.hotel},\n\nYour subscription has expired and your account is read-only. Nothing has been deleted: you can view and export all your data, and choose a plan to continue.${sign}` };
    case "CANCELLED": return { subject: "Your subscription has ended", text: `Hello ${v.hotel},\n\nYour subscription has ended as you asked. Your data is kept and you can still view and export it. You can choose a plan again at any time.${sign}` };
  }
}

async function notify(db: PrismaClient, tenantId: string, notice: Notice, key: string, v: { plan: string; date: string; amount?: string; invoice?: string }) {
  const owners = await db.membership.findMany({ where: { tenantId, active: true, role: "HOTEL_OWNER" }, include: { user: true } });
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { displayName: true } });
  const msg = emailFor(notice, { hotel: tenant?.displayName ?? "there", ...v });
  for (const o of owners) {
    await deliverEmail(db, { tenantId, kind: "ACCOUNT", to: o.user.email, subject: msg.subject, text: msg.text, idempotencyKey: `sub:${key}:${o.userId}` });
  }
  return owners.length;
}

/**
 * The daily subscription job: reminders, renewal invoices, and the move from payment due to past due, suspended and
 * expired. Safe to run twice in a day: each change is guarded by the status it started from and each email by a key.
 * Hotels with no price and no end date (the founding customers) are never touched.
 */
export async function runSubscriptionJob(db: PrismaClient, now = new Date()) {
  const { subs, cfg, retries } = await withPlatform(db, async (tx) => {
    const settings = await platformSettings(tx);
    return {
      cfg: configOf(settings),
      subs: await tx.subscription.findMany({ where: { status: { in: ["TRIAL", "ACTIVE", "PAYMENT_DUE", "PAST_DUE", "SUSPENDED"] } }, include: { plan: true } }),
      retries: await tx.subscriptionInvoice.findMany({ where: { status: "OPEN", nextRetryAt: { lte: now } } }),
    };
  });
  const out = { checked: subs.length, changed: 0, invoices: 0, emails: 0, reminders: 0, failed: 0 };
  for (const s of subs) {
    try {
      const changed = await withTenant(db, s.tenantId, async (tx) => {
        const open = await tx.subscriptionInvoice.count({ where: { tenantId: s.tenantId, status: "OPEN", kind: { in: ["NEW", "RENEWAL"] } } });
        const e = evaluate({
          status: s.status as SubStatus, periodEnd: s.periodEnd, trialEndsAt: s.trialEndsAt, graceEndsAt: s.graceEndsAt,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd, priceOverrideMinor: s.priceOverrideMinor, hasOpenInvoice: open > 0,
        }, now, cfg);
        let invoice: { number: string; grossMinor: number } | null = null;
        if (e.status !== s.status || e.graceEndsAt?.getTime() !== s.graceEndsAt?.getTime()) {
          // Only the run that still sees the old status makes the change.
          const won = await tx.subscription.updateMany({ where: { id: s.id, status: s.status }, data: { status: e.status, graceEndsAt: e.graceEndsAt } });
          if (won.count === 0) return null;
          await tx.subscriptionEvent.create({ data: { tenantId: s.tenantId, subscriptionId: s.id, type: `status.${e.status.toLowerCase()}`, detail: { from: s.status, to: e.status } } });
          if (e.issueRenewal) {
            const inv = await issueRenewalInvoice(tx, s.id, now);
            invoice = { number: inv.number, grossMinor: inv.grossMinor };
          }
        }
        return { e, invoice };
      });
      if (!changed) continue;
      const { e, invoice } = changed;
      if (e.status !== s.status) out.changed++;
      if (invoice) out.invoices++;
      if (e.notice) {
        const when = e.notice === "TRIAL_ENDING" ? day(s.trialEndsAt) : e.notice === "PAST_DUE" ? day(e.graceEndsAt) : day(s.periodEnd);
        const stamp = e.notice === "TRIAL_ENDING" ? day(s.trialEndsAt) : day(s.periodEnd) || day(now);
        out.emails += await notify(db, s.tenantId, e.notice, `${s.id}:${e.notice}:${stamp}`, { plan: s.plan.name, date: when, invoice: invoice?.number, amount: invoice ? inr(invoice.grossMinor) : undefined });
      }
    } catch {
      out.failed++;
    }
  }
  // Open invoices whose next-reminder date has come: remind again, and move the date on until they are paid.
  for (const inv of retries) {
    try {
      const sub = subs.find((x) => x.tenantId === inv.tenantId);
      await withTenant(db, inv.tenantId, (tx) => tx.subscriptionInvoice.updateMany({ where: { id: inv.id, status: "OPEN" }, data: { nextRetryAt: addDays(now, 3) } }));
      out.reminders += await notify(db, inv.tenantId, "PAYMENT_REMINDER", `${inv.id}:remind:${day(now)}`, { plan: sub?.plan.name ?? "", date: day(inv.dueDate), invoice: inv.number, amount: inr(inv.grossMinor) });
    } catch {
      out.failed++;
    }
  }
  return out;
}

export { STATUS_LABEL };
