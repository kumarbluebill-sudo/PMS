import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { decryptSecret } from "@/server/crypto";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createProperty, createRoom, createRoomType, listProperties } from "@/server/services/rooms";
import { createBooking, quoteStay } from "@/server/services/booking";
import { checkIn } from "@/server/services/reservations";
import { openFolio, postCharge, postDiscount, postRoomNights } from "@/server/services/billing";
import { recordPayment, refundPayment } from "@/server/services/payments";
import { reportIssue } from "@/server/services/roomBlocks";
import { roomBoard } from "@/server/services/dashboard";
import { recordAuthEvent } from "@/server/services/accounts";
import { addRestoreTest, getSettingsForAdmin, setSettings, settingsFor } from "@/server/services/settings";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let deluxe: string;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asRole = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
let n = 0;
let win = 40;
const dates = (nights = 2) => {
  const from = addDays(today, (win += 7));
  return { arrival: from, departure: addDays(from, nights) };
};
const book = (extra: object = {}) =>
  createBooking(app, owner, { newGuest: { name: `Set Guest ${++n}`, mobile: `9333${String(100000 + n)}` }, roomTypeId: deluxe, ...dates(), adults: 1, ...extra });
const reset = (v: Record<string, unknown>) => setSettings(app, owner, v);

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  const mk = async (label: string) =>
    loadContext(app, {
      userId: (await registerTenant(app, { businessName: `B ${label}`, propertyName: `H ${label}`, name: "Owner", email: `st-${label}-${sfx}@test.local`, password: "correct-horse-battery" })).userId,
      epoch: 0,
    });
  owner = await mk("a");
  other = await mk("b");
  today = (await roomBoard(app, owner)).today;
  deluxe = (await createRoomType(app, owner, { name: "Deluxe", maxAdults: 3, baseRateMinor: 450_000 })).id;
  for (let i = 0; i < 6; i++) await createRoom(app, owner, { roomTypeId: deluxe, number: String(500 + i) });
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("storing and reading settings", () => {
  it("returns defaults, then the saved values after a reload, and audits only real changes", async () => {
    const before = await settingsFor(app, owner);
    expect(before["reservation.referencePrefix"]).toBe("MK");
    expect(before["billing.maxDiscountPercent"]).toBe(100);

    await setSettings(app, owner, { "general.phone": "+91 98765 43210", "billing.invoiceTerms": "Pay on receipt.", "reservation.minNights": 1 });
    const after = await settingsFor(app, owner);
    expect(after["general.phone"]).toBe("+91 98765 43210");
    expect(after["billing.invoiceTerms"]).toBe("Pay on receipt.");
    const log = await admin.auditLog.findFirstOrThrow({ where: { tenantId: owner.tenantId, action: "settings.update" }, orderBy: { at: "desc" } });
    expect(log.before).toMatchObject({ "general.phone": "" });
    expect(log.after).toMatchObject({ "general.phone": "+91 98765 43210" });
    expect(JSON.stringify(log.after)).not.toContain("reservation.minNights"); // unchanged value, not logged

    const count = await admin.auditLog.count({ where: { tenantId: owner.tenantId, action: "settings.update" } });
    await setSettings(app, owner, { "general.phone": "+91 98765 43210" });
    expect(await admin.auditLog.count({ where: { tenantId: owner.tenantId, action: "settings.update" } })).toBe(count);
  });

  it("rejects unknown keys, wrong types and unsafe or inconsistent values, saving nothing", async () => {
    await expect(setSettings(app, owner, { "made.up": 1 })).rejects.toThrow(/Unknown setting/);
    await expect(setSettings(app, owner, {})).rejects.toThrow(/Nothing to save/);
    await expect(setSettings(app, owner, { "reservation.referencePrefix": "abc" })).rejects.toThrow(/capital letters/);
    await expect(setSettings(app, owner, { "general.website": "javascript:alert(1)" })).rejects.toThrow(/https/);
    await expect(setSettings(app, owner, { "billing.maxDiscountPercent": "ten" })).rejects.toThrow();
    await expect(setSettings(app, owner, { "billing.enabledPaymentMethods": [] })).rejects.toThrow(/at least one/);
    await expect(setSettings(app, owner, { "billing.enabledPaymentMethods": ["BITCOIN"] })).rejects.toThrow();
    await expect(setSettings(app, owner, { "reservation.minNights": 5, "reservation.maxNights": 3 })).rejects.toThrow(/minimum stay/i);
    // A rejected save is all-or-nothing.
    await expect(setSettings(app, owner, { "general.email": "valid@example.com", "general.website": "ftp://x" })).rejects.toThrow();
    expect((await settingsFor(app, owner))["general.email"]).toBe("");
  });

  it("only users with the right permission can change protected settings", async () => {
    await expect(setSettings(app, asRole(owner, "FRONT_DESK"), { "general.phone": "1" })).rejects.toThrow(/permission/i);
    await expect(setSettings(app, asRole(owner, "ACCOUNTS_MANAGER"), { "billing.invoiceTerms": "x" })).rejects.toThrow(/permission/i);
    await expect(getSettingsForAdmin(app, asRole(owner, "FRONT_DESK"))).rejects.toThrow(/permission/i);
    expect(await getSettingsForAdmin(app, asRole(owner, "AUDITOR"))).toBeTruthy(); // read-only role can view
    await expect(setSettings(app, asRole(owner, "AUDITOR"), { "general.phone": "1" })).rejects.toThrow(/permission/i);
    // Session limits need user-management authority; backup policy needs backup authority (not even a general manager).
    await expect(setSettings(app, asRole(owner, "ACCOUNTS_MANAGER"), { "security.sessionMinutes": 30 })).rejects.toThrow(/permission/i);
    await expect(setSettings(app, asRole(owner, "GENERAL_MANAGER"), { "backup.retentionDays": 10 })).rejects.toThrow(/permission/i);
    await expect(setSettings(app, asRole(owner, "GENERAL_MANAGER"), { "general.phone": "+91 1" })).resolves.toBeTruthy();
    await expect(setSettings(app, owner, { "backup.retentionDays": 90 })).resolves.toBeTruthy();
    await addRestoreTest(app, owner, { date: today, result: "PASSED", notes: "restored to staging" });
    expect((await settingsFor(app, owner))["backup.restoreTests"]).toEqual([{ date: today, result: "PASSED", notes: "restored to staging" }]);
    await expect(addRestoreTest(app, asRole(owner, "GENERAL_MANAGER"), { date: today, result: "PASSED", notes: "" })).rejects.toThrow(/permission/i);
  });

  it("keeps secrets encrypted, never returns them, and a blank value leaves them unchanged", async () => {
    await setSettings(app, owner, { "notifications.provider": "SENDGRID", "notifications.apiKey": "SG.super-secret-key-123" });
    const row = await admin.setting.findFirstOrThrow({ where: { tenantId: owner.tenantId, key: "notifications.apiKey" } });
    expect(JSON.stringify(row.value)).not.toContain("super-secret");
    expect(decryptSecret(row.value as string)).toBe("SG.super-secret-key-123");
    const view = await getSettingsForAdmin(app, owner);
    expect(view.values["notifications.apiKey"]).toBe("");
    expect(view.secretsSet.has("notifications.apiKey")).toBe(true);
    expect(JSON.stringify(view)).not.toContain("super-secret");
    const log = await admin.auditLog.findFirstOrThrow({ where: { tenantId: owner.tenantId, action: "settings.update", after: { path: ["notifications.apiKey"], not: "" } } });
    expect(JSON.stringify(log)).not.toContain("super-secret");
    await setSettings(app, owner, { "notifications.apiKey": "", "notifications.fromEmail": "desk@example.com" });
    expect(decryptSecret((await admin.setting.findFirstOrThrow({ where: { tenantId: owner.tenantId, key: "notifications.apiKey" } })).value as string)).toBe("SG.super-secret-key-123");
    await expect(setSettings(app, owner, { "notifications.apiKey": "short" })).rejects.toThrow();
  });

  it("is isolated per business and per property, with tenant-wide keys shared", async () => {
    expect((await settingsFor(app, other))["general.phone"]).toBe("");
    expect((await settingsFor(app, other))["notifications.provider"]).toBe("NONE");
    await expect(createProperty(app, asRole(owner, "PROPERTY_MANAGER"), { name: "Nope" })).rejects.toThrow(/Only an owner/);
    const second = await createProperty(app, owner, { name: "Second Inn" });
    const ctx2: Ctx = { ...owner, propertyId: second.id, accessiblePropertyIds: [...owner.accessiblePropertyIds, second.id] };
    expect((await settingsFor(app, ctx2))["general.phone"]).toBe(""); // property scope
    expect((await settingsFor(app, ctx2))["notifications.provider"]).toBe("SENDGRID"); // tenant scope
    await setSettings(app, ctx2, { "general.phone": "222" });
    expect((await settingsFor(app, owner))["general.phone"]).not.toBe("222");
    expect((await listProperties(app, ctx2)).map((p) => p.name)).toContain("Second Inn");
    // Another business, even pointed at this property's id, sees defaults only.
    expect((await settingsFor(app, { tenantId: other.tenantId, propertyId: second.id }))["general.phone"]).toBe("");
  });
});

describe("the hotel's rules are applied where they matter", () => {
  it("booking reference prefix", async () => {
    await reset({ "reservation.referencePrefix": "HX" });
    expect((await book()).reservations[0].reference).toMatch(/^HX-[0-9A-F]{8}$/);
    await reset({ "reservation.referencePrefix": "MK" });
    expect((await book()).reservations[0].reference).toMatch(/^MK-/);
  });

  it("minimum and maximum stay", async () => {
    await reset({ "reservation.minNights": 2, "reservation.maxNights": 4 });
    await expect(quoteStay(app, owner, { roomTypeId: deluxe, ...dates(1) })).rejects.toThrow(/minimum stay is 2/);
    await expect(book({ ...dates(5) })).rejects.toThrow(/maximum stay is 4/);
    await expect(book({ ...dates(3) })).resolves.toBeTruthy();
    await reset({ "reservation.minNights": 1, "reservation.maxNights": 365 });
  });

  it("enabled booking sources (legacy values still accepted)", async () => {
    await reset({ "reservation.enabledSources": ["WALK_IN", "PHONE"] });
    await expect(book({ source: "OTA" })).rejects.toThrow(/not in use/);
    await expect(book({ source: "PHONE" })).resolves.toBeTruthy();
    await expect(book({ source: "DIRECT" })).resolves.toBeTruthy();
    await reset({ "reservation.enabledSources": ["WALK_IN", "PHONE", "DIRECT_WEBSITE", "TRAVEL_AGENT", "CORPORATE", "OTA", "OTHER"] });
  });

  it("largest allowed discount, on bookings and on folios", async () => {
    await reset({ "billing.maxDiscountPercent": 10 });
    await expect(book({ discountPercentBp: 1500, discountReason: "friend" })).rejects.toThrow(/limited to 10%/);
    await expect(book({ discountAmountMinor: 100_000, discountReason: "friend" })).rejects.toThrow(/limited to 10%/); // 22% off
    await expect(book({ discountPercentBp: 1000, discountReason: "repeat guest" })).resolves.toBeTruthy();
    const r = (await book()).reservations[0];
    await admin.room.updateMany({ where: { tenantId: owner.tenantId }, data: { housekeeping: "CLEAN" } });
    const stay = await createBooking(app, owner, { newGuest: { name: "Folio Guest", mobile: "9333999991" }, roomTypeId: deluxe, arrival: today, departure: addDays(today, 1), adults: 1 });
    await checkIn(app, owner, stay.reservations[0].id);
    const folio = await openFolio(app, owner, stay.reservations[0].id);
    await postCharge(app, owner, folio.id, { category: "FNB", description: "Dinner", amountMinor: 100_000, idempotencyKey: key() });
    await expect(postDiscount(app, owner, folio.id, { category: "FNB", description: "Goodwill", amountMinor: 20_000 }, "complaint")).rejects.toThrow(/limited to 10%/);
    await expect(postDiscount(app, owner, folio.id, { category: "FNB", description: "Goodwill", amountMinor: 10_000 }, "complaint")).resolves.toBeTruthy();
    await expect(postDiscount(app, owner, folio.id, { category: "FNB", description: "More", amountMinor: 1_000 }, "complaint")).rejects.toThrow(/limited to 10%/);
    expect(r.reference).toBeTruthy();
    await reset({ "billing.maxDiscountPercent": 100 });
  });

  it("payment methods in use, and the refund approval limit", async () => {
    const stay = await createBooking(app, owner, { newGuest: { name: "Pay Guest", mobile: "9333999992" }, roomTypeId: deluxe, arrival: today, departure: addDays(today, 1), adults: 1 });
    await admin.room.updateMany({ where: { tenantId: owner.tenantId }, data: { housekeeping: "CLEAN" } });
    await checkIn(app, owner, stay.reservations[0].id);
    const folio = await openFolio(app, owner, stay.reservations[0].id);
    await postRoomNights(app, owner, stay.reservations[0].id);

    await reset({ "billing.enabledPaymentMethods": ["CASH", "UPI"] });
    await expect(recordPayment(app, owner, folio.id, { method: "CARD", amountMinor: 100_000, idempotencyKey: key() })).rejects.toThrow(/not in use/);
    await recordPayment(app, owner, folio.id, { method: "UPI", amountMinor: 400_000, idempotencyKey: key() });
    await reset({ "billing.enabledPaymentMethods": ["CASH", "UPI", "CARD", "BANK_TRANSFER", "COMPANY_CREDIT", "OTHER"] });

    await reset({ "billing.refundApprovalLimitMinor": 100_000 }); // ₹1,000
    const acct = asRole(owner, "ACCOUNTS_MANAGER");
    await expect(refundPayment(app, acct, folio.id, { method: "UPI", amountMinor: 200_000, reason: "guest left early" })).rejects.toThrow(/permission/i);
    await expect(refundPayment(app, acct, folio.id, { method: "UPI", amountMinor: 50_000, reason: "guest left early" })).resolves.toBeTruthy();
    await expect(refundPayment(app, owner, folio.id, { method: "UPI", amountMinor: 200_000, reason: "manager approved" })).resolves.toBeTruthy();
    await reset({ "billing.refundApprovalLimitMinor": 0 });
  });

  it("maintenance approval rule and categories in use", async () => {
    const tech = asRole(owner, "MAINTENANCE");
    const room = (await admin.room.findFirstOrThrow({ where: { tenantId: owner.tenantId, number: "505" } })).id;
    const input = { roomId: room, mode: "MAINTENANCE_BLOCK", category: "PLUMBING", title: "Leaking tap", startDate: addDays(today, 200) } as const;
    expect((await reportIssue(app, tech, input)).approvalRequired).toBe(true);
    await reset({ "rooms.maintenanceRequireApproval": false });
    expect((await reportIssue(app, tech, input)).approvalRequired).toBe(false);
    await reset({ "rooms.maintenanceCategories": ["ELECTRICAL", "OTHER"] });
    await expect(reportIssue(app, tech, input)).rejects.toThrow(/not in use/);
    await reset({ "rooms.maintenanceRequireApproval": true, "rooms.maintenanceCategories": ["PLUMBING", "ELECTRICAL", "AIR_CONDITIONING", "FURNITURE_DAMAGE", "BATHROOM", "RENOVATION", "SAFETY", "CLEANING", "OTHER"] });
  });

  it("deposit requested is a percentage of the estimate and reported against the advance", async () => {
    await reset({ "reservation.depositPercent": 20 });
    const q = await quoteStay(app, owner, { roomTypeId: deluxe, ...dates() });
    expect(q.depositRequiredMinor).toBe(180_000); // 20% of 9,000
    const none = await book();
    expect(none.deposit).toEqual({ requiredMinor: 180_000, met: false });
    const paid = await book({ advance: { amountMinor: 200_000, method: "UPI" } });
    expect(paid.deposit).toEqual({ requiredMinor: 180_000, met: true });
    await reset({ "reservation.depositPercent": 0 });
    expect((await book()).deposit).toEqual({ requiredMinor: 0, met: true });
  });

  it("status labels and colours are stored as given and only valid colours are accepted", async () => {
    await reset({ "rooms.statusLabels": { AVAILABLE: { label: "Ready to sell", color: "teal" } } });
    expect((await settingsFor(app, owner))["rooms.statusLabels"]).toEqual({ AVAILABLE: { label: "Ready to sell", color: "teal" } });
    await expect(reset({ "rooms.statusLabels": { AVAILABLE: { color: "neon" } } })).rejects.toThrow();
    await expect(reset({ "rooms.statusLabels": { NOT_A_STATUS: { label: "x" } } })).rejects.toThrow();
    await reset({ "rooms.statusLabels": {} });
  });
});

describe("sign-in monitoring", () => {
  it("records sign-in outcomes in the audit log of the user's business, and not another's", async () => {
    await recordAuthEvent(app, owner.userId, "auth.login");
    await recordAuthEvent(app, owner.userId, "auth.login_failed", "second factor");
    const mine = await admin.auditLog.findMany({ where: { tenantId: owner.tenantId, action: { startsWith: "auth." } } });
    expect(mine.map((m) => m.action).sort()).toEqual(["auth.login", "auth.login_failed"]);
    expect(mine.every((m) => m.actorId === owner.userId)).toBe(true);
    expect(await admin.auditLog.count({ where: { tenantId: other.tenantId, action: { startsWith: "auth." } } })).toBe(0);
    await recordAuthEvent(app, randomUUID(), "auth.login"); // unknown user: silently nothing
  });
});
