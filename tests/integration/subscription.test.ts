import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { withPlatform } from "@/server/db/withPlatform";
import { registerTenant } from "@/server/services/tenant";
import { createProperty, createRoom, createRoomType, listRooms } from "@/server/services/rooms";
import { createRoomsBulk } from "@/server/services/property";
import { inviteMember } from "@/server/services/accounts";
import {
  applyCouponCode, cancelSubscription, changePlan, clearScheduledChange, previewPlanChange, resumeSubscription, subscriptionOverview,
} from "@/server/services/subscription";
import {
  adminAction, adminFailPayment, adminRecordPayment, adminVoidInvoice, listSubscriptions, platformOverview, runSubscriptionJob, upsertCoupon, upsertPlan, type PlatformCtx,
} from "@/server/services/platform";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let n = 0;
const super_: PlatformCtx = { userId: randomUUID(), role: "PLATFORM_SUPER_ADMIN", requestId: "t" };
const support: PlatformCtx = { userId: randomUUID(), role: "SAAS_SUPPORT_ADMIN", requestId: "t" };
const day = (d: Date | null) => d?.toISOString().slice(0, 10);
const plus = (d: Date, k: number) => new Date(d.getTime() + k * 86_400_000);

async function hotel(plan?: string): Promise<Ctx> {
  const label = `s${++n}`;
  const r = await registerTenant(app, { businessName: `Sub ${label} ${sfx}`, propertyName: `Hotel ${label}`, name: "Owner", email: `sub-${label}-${sfx}@test.local`, password: "correct-horse-battery", ...(plan && { plan }) });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
const fresh = (c: Ctx) => loadContext(app, { userId: c.userId, epoch: 0 });
const ctxFor = async (c: Ctx) => ({ ...(await fresh(c)), propertyId: c.propertyId });
const sub = (c: Ctx) => admin.subscription.findUniqueOrThrow({ where: { tenantId: c.tenantId }, include: { plan: true } });
const pay = (c: Ctx, invoiceId: string, amountMinor: number, key = randomUUID()) =>
  adminRecordPayment(app, super_, c.tenantId, { invoiceId, amountMinor, method: "UPI", reference: "UTR1", idempotencyKey: key });

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("plans are data, and a new hotel starts a trial", () => {
  it("has the four seeded plans with editable prices", async () => {
    const plans = await admin.plan.findMany({ where: { code: { in: ["starter", "professional", "growth", "enterprise"] } }, orderBy: { sortOrder: "asc" } });
    expect(plans.map((p) => p.code)).toEqual(["starter", "professional", "growth", "enterprise"]);
    expect(plans.map((p) => p.monthlyPriceMinor)).toEqual([99_900, 249_900, 499_900, 999_900]);
    expect(plans[3].customPricing).toBe(true);
  });

  it("starts the chosen plan on a trial of the plan's days", async () => {
    const c = await hotel("starter");
    const s = await sub(c);
    expect(s.status).toBe("TRIAL");
    expect(s.plan.code).toBe("starter");
    expect(day(s.trialEndsAt)).toBe(day(plus(new Date(), 14)));
    expect(c.subscriptionStatus).toBe("TRIAL");
    expect(c.readOnly).toBe(false);
  });

  it("falls back to the platform default plan for an unknown or missing choice", async () => {
    expect((await sub(await hotel("no-such-plan"))).plan.code).toBe("enterprise"); // the test database's default
    expect((await sub(await hotel())).plan.code).toBe("enterprise");
  });
});

describe("plan limits are enforced where things are created", () => {
  it("refuses the 16th room on Starter with a message that says what to do", async () => {
    const c = await hotel("starter");
    const rt = await createRoomType(app, c, { name: "Std", baseRateMinor: 100_000, maxAdults: 2 });
    await createRoomsBulk(app, c, { roomTypeId: rt.id, prefix: "R", from: 1, to: 15 });
    await expect(createRoom(app, c, { roomTypeId: rt.id, number: "R99" })).rejects.toMatchObject({
      code: "PLAN_LIMIT", message: "Your Starter plan allows 15 rooms. Upgrade your plan to add more.",
    });
    expect(await admin.room.count({ where: { tenantId: c.tenantId } })).toBe(15);
  });

  it("refuses a second property on Starter and a bulk add that would pass the limit", async () => {
    const c = await hotel("starter");
    await expect(createProperty(app, c, { name: "Second" })).rejects.toMatchObject({ code: "PLAN_LIMIT" });
    const rt = await createRoomType(app, c, { name: "Std", baseRateMinor: 100_000, maxAdults: 2 });
    await expect(createRoomsBulk(app, c, { roomTypeId: rt.id, prefix: "A", from: 1, to: 16 })).rejects.toMatchObject({ code: "PLAN_LIMIT" });
    expect(await admin.room.count({ where: { tenantId: c.tenantId } })).toBe(0);
  });

  it("counts pending invitations against the user limit", async () => {
    const c = await hotel("starter"); // 3 users
    await inviteMember(app, c, { email: `a-${sfx}-${n}@test.local`, role: "FRONT_DESK", propertyIds: [c.propertyId!] });
    await inviteMember(app, c, { email: `b-${sfx}-${n}@test.local`, role: "FRONT_DESK", propertyIds: [c.propertyId!] });
    await expect(inviteMember(app, c, { email: `c-${sfx}-${n}@test.local`, role: "FRONT_DESK", propertyIds: [c.propertyId!] })).rejects.toMatchObject({ code: "PLAN_LIMIT" });
  });

  it("does not limit the unlimited plan", async () => {
    const c = await hotel("enterprise");
    await expect(createProperty(app, c, { name: "Second" })).resolves.toBeTruthy();
  });
});

describe("subscribing, paying and the invoice series", () => {
  it("issues a GST invoice, numbers it in the provider series and activates on payment", async () => {
    const c = await hotel("professional");
    const change = await changePlan(app, c, { planCode: "professional", interval: "MONTHLY" });
    expect(change.mode).toBe("SUBSCRIBE");
    const [inv] = await admin.subscriptionInvoice.findMany({ where: { tenantId: c.tenantId } });
    expect(inv.number).toMatch(/^MKS\/\d{4}-\d{2}\/\d{5}$/);
    expect(inv.kind).toBe("NEW");
    expect([inv.netMinor, inv.taxMinor, inv.grossMinor]).toEqual([249_900, 44_982, 294_882]);
    expect((await sub(c)).status).toBe("TRIAL"); // not active until paid
    // Part payment leaves it open; the rest activates it.
    await pay(c, inv.id, 100_000);
    expect((await sub(c)).status).toBe("TRIAL");
    const key = randomUUID();
    const r1 = await pay(c, inv.id, 194_882, key);
    const r2 = await pay(c, inv.id, 194_882, key); // the same request again
    expect(r2.duplicate).toBe(true);
    expect(r2.payment.id).toBe(r1.payment.id);
    const s = await sub(c);
    expect(s.status).toBe("ACTIVE");
    expect(s.trialEndsAt).toBeNull();
    expect(day(s.periodEnd)).toBe(day(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, new Date().getUTCDate()))));
    expect((await admin.subscriptionInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    expect(await admin.subscriptionPayment.count({ where: { invoiceId: inv.id } })).toBe(2);
  });

  it("refuses to take more than is owed or to pay a paid invoice", async () => {
    const c = await hotel("starter");
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    await expect(pay(c, inv.id, inv.grossMinor + 1)).rejects.toMatchObject({ code: "VALIDATION" });
    await pay(c, inv.id, inv.grossMinor);
    await expect(pay(c, inv.id, 100)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("uses the annual price with the annual discount", async () => {
    const c = await hotel("starter");
    await changePlan(app, c, { planCode: "starter", interval: "ANNUAL" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    expect(inv.netMinor).toBe(Math.round((99_900 * 12 * (10_000 - 1667)) / 10_000));
  });

  it("rejects the custom-priced plan for self-service and unknown plans", async () => {
    const c = await hotel("starter");
    await expect(changePlan(app, c, { planCode: "enterprise", interval: "MONTHLY" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(changePlan(app, c, { planCode: "nope", interval: "MONTHLY" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("only an owner-level role can change the plan", async () => {
    const c = await hotel("starter");
    const desk = { ...c, role: "FRONT_DESK" as const, extra: [] };
    await expect(changePlan(app, desk, { planCode: "starter", interval: "MONTHLY" })).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(subscriptionOverview(app, desk)).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});

describe("upgrades, downgrades, cancelling", () => {
  async function activeStarter() {
    const c = await hotel("starter");
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    await pay(c, inv.id, inv.grossMinor);
    return c;
  }

  it("upgrades at once and bills only the unused part of the period", async () => {
    const c = await activeStarter();
    const prev = await previewPlanChange(app, c, { planCode: "professional", interval: "MONTHLY" });
    expect(prev.mode).toBe("UPGRADE");
    expect(prev.dueMinor).toBeGreaterThan(0);
    expect(prev.dueMinor).toBeLessThanOrEqual(249_900 - 99_900);
    await changePlan(app, c, { planCode: "professional", interval: "MONTHLY" });
    const s = await sub(c);
    expect(s.plan.code).toBe("professional"); // the new limits apply immediately
    const up = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId, kind: "UPGRADE" } });
    expect(up.netMinor).toBe(prev.dueMinor);
    expect(up.grossMinor).toBe(prev.grossMinor);
  });

  it("schedules a downgrade for renewal and refuses it while usage is over the new limits", async () => {
    const c = await hotel("professional");
    await changePlan(app, c, { planCode: "professional", interval: "MONTHLY" });
    await pay(c, (await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } })).id, 294_882);
    const rt = await createRoomType(app, c, { name: "Std", baseRateMinor: 100_000, maxAdults: 2 });
    await createRoomsBulk(app, c, { roomTypeId: rt.id, prefix: "B", from: 1, to: 20 });
    await expect(changePlan(app, c, { planCode: "starter", interval: "MONTHLY" })).rejects.toMatchObject({
      code: "VALIDATION", message: "Starter allows 15 rooms and you have 20. Reduce this by 5 first.",
    });
    await admin.room.updateMany({ where: { tenantId: c.tenantId, number: { in: ["B16", "B17", "B18", "B19", "B20"] } }, data: { active: false } });
    const r = await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    expect(r.mode).toBe("SCHEDULE");
    const s = await sub(c);
    expect(s.plan.code).toBe("professional"); // still on the old plan until renewal
    expect(s.pendingPlanId).toBeTruthy();
    await clearScheduledChange(app, c);
    expect((await sub(c)).pendingPlanId).toBeNull();
  });

  it("cancels at period end without cutting access, and can be undone", async () => {
    const c = await activeStarter();
    await cancelSubscription(app, c, "Closing the hotel");
    let s = await sub(c);
    expect(s.cancelAtPeriodEnd).toBe(true);
    expect(s.status).toBe("ACTIVE");
    await resumeSubscription(app, c);
    s = await sub(c);
    expect(s.cancelAtPeriodEnd).toBe(false);
    await expect(resumeSubscription(app, c)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(cancelSubscription(app, c, "x")).rejects.toThrow();
  });
});

describe("coupons", () => {
  it("applies once, to the right plan, and discounts the next invoice", async () => {
    const code = `TEST${sfx}${n}`.toUpperCase().slice(0, 20);
    await upsertCoupon(app, super_, { code, kind: "PERCENT", value: 2000, months: 2, planCodes: ["starter"], maxRedemptions: 1 });
    const c = await hotel("starter");
    await applyCouponCode(app, c, code);
    await expect(applyCouponCode(app, c, code)).rejects.toMatchObject({ code: "CONFLICT" });
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    expect(inv.netMinor).toBe(99_900 - 19_980);
    // The only redemption is used; another hotel cannot take it, and a wrong plan is refused.
    const d = await hotel("starter");
    await expect(applyCouponCode(app, d, code)).rejects.toMatchObject({ code: "VALIDATION" });
    const code2 = `ONLYPRO${sfx}`.toUpperCase().slice(0, 20);
    await upsertCoupon(app, super_, { code: code2, kind: "AMOUNT", value: 10_000, planCodes: ["professional"] });
    await expect(applyCouponCode(app, d, code2)).rejects.toMatchObject({ message: "This coupon does not apply to the chosen plan." });
  });

  it("a hundred percent coupon makes a free invoice that activates the plan", async () => {
    const code = `FREE${sfx}${n}`.toUpperCase().slice(0, 20);
    await upsertCoupon(app, super_, { code, kind: "PERCENT", value: 10_000, months: 1 });
    const c = await hotel("starter");
    await applyCouponCode(app, c, code);
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const s = await sub(c);
    expect(s.status).toBe("ACTIVE");
    expect((await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } })).status).toBe("PAID");
  });
});

describe("read-only mode keeps data and export", () => {
  it("refuses changes everywhere but still shows everything and allows the subscription pages", async () => {
    const c = await hotel("starter");
    const rt = await createRoomType(app, c, { name: "Std", baseRateMinor: 100_000, maxAdults: 2 });
    await createRoom(app, c, { roomTypeId: rt.id, number: "101" });
    await adminAction(app, super_, { action: "SUSPEND", tenantId: c.tenantId, reason: "Unpaid invoice" });
    const ro = await ctxFor(c);
    expect(ro.readOnly).toBe(true);
    expect(ro.subscriptionStatus).toBe("SUSPENDED");
    await expect(createRoom(app, ro, { roomTypeId: rt.id, number: "102" })).rejects.toMatchObject({ code: "READ_ONLY" });
    await expect(createProperty(app, ro, { name: "More" })).rejects.toMatchObject({ code: "READ_ONLY" });
    const rooms = await listRooms(app, ro);
    expect(rooms.map((r) => r.number)).toContain("101"); // nothing was deleted
    const o = await subscriptionOverview(app, ro);
    expect(o?.status).toBe("SUSPENDED");
    // The owner can still choose a plan to get back in.
    await expect(changePlan(app, ro, { planCode: "starter", interval: "MONTHLY" })).resolves.toMatchObject({ mode: "SUBSCRIBE" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    await pay(c, inv.id, inv.grossMinor);
    const back = await ctxFor(c);
    expect(back.readOnly).toBe(false);
    await expect(createRoom(app, back, { roomTypeId: rt.id, number: "102" })).resolves.toBeTruthy();
  });

  it("founding hotels (active, no end date, zero price) are never read-only and never billed", async () => {
    const c = await hotel("enterprise");
    await admin.subscription.update({ where: { tenantId: c.tenantId }, data: { status: "ACTIVE", priceOverrideMinor: 0, periodEnd: null, trialEndsAt: null } });
    const out = await runSubscriptionJob(app, plus(new Date(), 4000));
    expect(out.failed).toBe(0);
    expect((await sub(c)).status).toBe("ACTIVE");
    expect(await admin.subscriptionInvoice.count({ where: { tenantId: c.tenantId } })).toBe(0);
  });
});

describe("the daily job", () => {
  async function activeMonthly() {
    const c = await hotel("starter");
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    await pay(c, inv.id, inv.grossMinor);
    return c;
  }
  const mails = (c: Ctx) => admin.emailOutbox.count({ where: { tenantId: c.tenantId, idempotencyKey: { startsWith: "sub:" } } });

  it("issues the renewal invoice ahead of the end, then past due, suspended and expired, each email once", async () => {
    const c = await activeMonthly();
    const end = (await sub(c)).periodEnd!;
    let out = await runSubscriptionJob(app, plus(end, -10));
    expect((await sub(c)).status).toBe("ACTIVE");
    out = await runSubscriptionJob(app, plus(end, -5));
    expect(out.invoices).toBeGreaterThanOrEqual(1);
    let s = await sub(c);
    expect(s.status).toBe("PAYMENT_DUE");
    const renewals = await admin.subscriptionInvoice.findMany({ where: { tenantId: c.tenantId, kind: "RENEWAL" } });
    expect(renewals).toHaveLength(1);
    expect(day(renewals[0].periodStart)).toBe(day(end));
    expect(await mails(c)).toBe(1);
    // Running again the same day does nothing more.
    await runSubscriptionJob(app, plus(end, -5));
    expect(await admin.subscriptionInvoice.count({ where: { tenantId: c.tenantId, kind: "RENEWAL" } })).toBe(1);
    expect(await mails(c)).toBe(1);
    await runSubscriptionJob(app, plus(end, 1));
    s = await sub(c);
    expect(s.status).toBe("PAST_DUE");
    expect(day(s.graceEndsAt)).toBe(day(plus(end, 7)));
    expect((await ctxFor(c)).readOnly).toBe(false); // grace: still full access
    await runSubscriptionJob(app, plus(end, 8));
    expect((await sub(c)).status).toBe("SUSPENDED");
    expect((await ctxFor(c)).readOnly).toBe(true);
    await runSubscriptionJob(app, plus(end, 8 + 61));
    expect((await sub(c)).status).toBe("EXPIRED");
    expect(await mails(c)).toBe(4);
    await runSubscriptionJob(app, plus(end, 8 + 61));
    expect(await mails(c)).toBe(4);
  });

  it("paying the renewal invoice extends from the old end date and clears the overdue state", async () => {
    const c = await activeMonthly();
    const before = await sub(c);
    await runSubscriptionJob(app, plus(before.periodEnd!, -3));
    const renewal = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId, kind: "RENEWAL" } });
    await pay(c, renewal.id, renewal.grossMinor);
    const s = await sub(c);
    expect(s.status).toBe("ACTIVE");
    expect(day(s.periodStart)).toBe(day(before.periodEnd));
    expect(s.periodEnd!.getTime()).toBeGreaterThan(before.periodEnd!.getTime());
  });

  it("a scheduled downgrade is priced on the renewal invoice and applies when it is paid", async () => {
    const c = await hotel("professional");
    await changePlan(app, c, { planCode: "professional", interval: "MONTHLY" });
    await pay(c, (await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } })).id, 294_882);
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const before = await sub(c);
    await runSubscriptionJob(app, plus(before.periodEnd!, -2));
    const renewal = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId, kind: "RENEWAL" } });
    expect(renewal.netMinor).toBe(99_900);
    await pay(c, renewal.id, renewal.grossMinor);
    const s = await sub(c);
    expect(s.plan.code).toBe("starter");
    expect(s.pendingPlanId).toBeNull();
  });

  it("a trial reminds then expires into read-only without deleting anything", async () => {
    const c = await hotel("starter");
    const rt = await createRoomType(app, c, { name: "Std", baseRateMinor: 100_000, maxAdults: 2 });
    await createRoom(app, c, { roomTypeId: rt.id, number: "T1" });
    const end = (await sub(c)).trialEndsAt!;
    await runSubscriptionJob(app, plus(end, -2));
    expect((await sub(c)).status).toBe("TRIAL");
    expect(await mails(c)).toBe(1);
    await runSubscriptionJob(app, plus(end, 0));
    expect((await sub(c)).status).toBe("EXPIRED");
    const ro = await ctxFor(c);
    expect(ro.readOnly).toBe(true);
    expect((await listRooms(app, ro)).length).toBe(1);
  });

  it("failed attempts are kept, move the reminder date and repeat the reminder", async () => {
    const c = await hotel("starter");
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    await adminFailPayment(app, super_, c.tenantId, { invoiceId: inv.id, reason: "Cheque bounced", retryInDays: 2 });
    const after = await admin.subscriptionInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.attempts).toBe(1);
    expect(after.nextRetryAt).toBeTruthy();
    const out = await runSubscriptionJob(app, plus(after.nextRetryAt!, 0));
    expect(out.reminders).toBeGreaterThanOrEqual(1);
    const moved = await admin.subscriptionInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(moved.nextRetryAt!.getTime()).toBeGreaterThan(after.nextRetryAt!.getTime());
  });
});

describe("platform console rules", () => {
  it("is for platform roles only, and support staff cannot touch money or plans", async () => {
    const c = await hotel("starter");
    const owner: PlatformCtx = { userId: c.userId, role: "HOTEL_OWNER", requestId: "t" };
    await expect(listSubscriptions(app, owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminAction(app, owner, { action: "SUSPEND", tenantId: c.tenantId, reason: "no" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listSubscriptions(app, support)).resolves.toBeTruthy();
    await expect(adminAction(app, support, { action: "SUSPEND", tenantId: c.tenantId, reason: "no way" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminRecordPayment(app, support, c.tenantId, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(upsertPlan(app, support, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Support may help a customer with more trial time.
    await expect(adminAction(app, support, { action: "EXTEND_TRIAL", tenantId: c.tenantId, reason: "Needs more time", days: 7 })).resolves.toBeTruthy();
    expect(day((await sub(c)).trialEndsAt)).toBe(day(plus(new Date(), 21)));
  });

  it("every action needs a reason and is audited against the hotel", async () => {
    const c = await hotel("starter");
    await expect(adminAction(app, super_, { action: "SUSPEND", tenantId: c.tenantId, reason: "" })).rejects.toThrow();
    await adminAction(app, super_, { action: "CHANGE_PLAN", tenantId: c.tenantId, reason: "Negotiated deal", planCode: "growth", interval: "ANNUAL", priceOverrideMinor: 400_000 });
    const s = await sub(c);
    expect([s.plan.code, s.interval, s.priceOverrideMinor]).toEqual(["growth", "ANNUAL", 400_000]);
    const log = await admin.auditLog.findFirst({ where: { tenantId: c.tenantId, action: "platform.subscription.change_plan" } });
    expect(log?.actorId).toBe(super_.userId);
    expect(log?.reason).toBe("Negotiated deal");
  });

  it("voids an open invoice but not a part-paid one", async () => {
    const c = await hotel("starter");
    await changePlan(app, c, { planCode: "starter", interval: "MONTHLY" });
    const inv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: c.tenantId } });
    await pay(c, inv.id, 10_000);
    await expect(adminVoidInvoice(app, super_, c.tenantId, inv.id, "Wrong customer")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("overview counts statuses and monthly revenue", async () => {
    const o = await platformOverview(app, super_);
    expect(o.total).toBeGreaterThan(0);
    expect(o.mrrMinor).toBeGreaterThanOrEqual(0);
  });
});

describe("isolation between hotels", () => {
  it("one hotel cannot read another's invoices, payments or subscription, and only platform code sees all", async () => {
    const a = await hotel("starter");
    const b = await hotel("starter");
    await changePlan(app, a, { planCode: "starter", interval: "MONTHLY" });
    await changePlan(app, b, { planCode: "starter", interval: "MONTHLY" });
    const seenByA = await withTenant(app, a.tenantId, async (tx) => ({
      subs: await tx.subscription.findMany(), invoices: await tx.subscriptionInvoice.findMany(), events: await tx.subscriptionEvent.findMany(),
    }));
    expect(seenByA.subs.map((s) => s.tenantId)).toEqual([a.tenantId]);
    expect(seenByA.invoices.every((i) => i.tenantId === a.tenantId)).toBe(true);
    expect(seenByA.events.every((e) => e.tenantId === a.tenantId)).toBe(true);
    // Without either flag, nothing is visible at all.
    expect(await app.subscription.count()).toBe(0);
    const all = await withPlatform(app, (tx) => tx.subscription.count());
    expect(all).toBeGreaterThanOrEqual(2);
    // A hotel cannot write a row for another hotel.
    await expect(withTenant(app, a.tenantId, (tx) => tx.subscriptionEvent.create({ data: { tenantId: b.tenantId, subscriptionId: randomUUID(), type: "x" } }))).rejects.toThrow();
    // Another hotel's invoice is not found through the service either.
    const bInv = await admin.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: b.tenantId } });
    await expect(adminRecordPayment(app, super_, a.tenantId, { invoiceId: bInv.id, amountMinor: 100, method: "UPI", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
