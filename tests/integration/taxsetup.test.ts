import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { gstinCheckChar } from "@/server/domain/gst";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { quoteStay } from "@/server/services/booking";
import { propertyToday } from "@/server/services/roomBlocks";
import { applyPreset, approveRule, confirmGstSetup, gstSetupStatus, gstWarning, previewTax, updateGstSettings, listRules } from "@/server/services/tax";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let approver: Ctx;
let other: Ctx;
let today: string;
const first14 = "29ABCDE1234F1Z";
const GSTIN = first14 + gstinCheckChar(first14);
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `tx-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  approver = { ...owner, userId: randomUUID() };
  other = await tenant("b");
  today = await propertyToday(app, owner);
});
afterAll(async () => { await app.$disconnect(); await admin.$disconnect(); });

describe("GST setup", () => {
  it("applies a preset as drafts, once, and warns until the details and confirmation are done", async () => {
    expect(await gstWarning(app, owner)).toBeNull(); // not registered: nothing to warn about
    const r1 = await applyPreset(app, owner, "accommodation-2025");
    expect(r1).toMatchObject({ created: 2, skipped: 0 });
    expect((await applyPreset(app, owner, "accommodation-2025")).created).toBe(0);
    const rules = await listRules(app, owner);
    expect(rules.filter((r) => r.category === "ROOM" && r.status === "DRAFT")).toHaveLength(2);
    expect(rules.every((r) => r.legalRef?.includes("ACCOUNTANT REVIEW REQUIRED"))).toBe(true);
    await expect(applyPreset(app, owner, "nope")).rejects.toThrow(/does not exist/);
    expect(await admin.auditLog.count({ where: { tenantId: owner.tenantId, action: "tax.preset_apply" } })).toBeGreaterThan(0);

    await expect(updateGstSettings(app, owner, { gstRegistered: true, gstin: GSTIN, legalName: "Palm Resort Pvt Ltd", address: "1 Beach Road, Goa", invoicePrefix: "PR" }, "GST setup wizard")).resolves.toBeTruthy();
    expect(await gstWarning(app, owner)).toMatch(/not been confirmed/);
    const s = await gstSetupStatus(app, owner);
    expect(s.missing).toEqual([]);
    expect(s.draftRules).toBe(2);
    expect(s.accommodation.every((a) => !a.covered)).toBe(true); // drafts price nothing yet
  });

  it("previews a calculation with drafts clearly marked, and refuses categories with no rule", async () => {
    const day = "2026-03-10";
    const low = await previewTax(app, owner, { category: "ROOM", tariffMinor: 750_000, nights: 2, inclusive: false, date: day });
    expect(low).toMatchObject({ error: null, usesDraft: true, totals: { netMinor: 1_500_000, taxMinor: 75_000, grossMinor: 1_575_000, cgstMinor: 37_500, sgstMinor: 37_500, igstMinor: 0 } });
    const high = await previewTax(app, owner, { category: "ROOM", tariffMinor: 750_100, nights: 1, inclusive: false, date: day });
    expect(high).toMatchObject({ totals: { taxMinor: 135_018 } });
    const fnb = await previewTax(app, owner, { category: "FNB", tariffMinor: 50_000, nights: 1, inclusive: false, date: day });
    expect(fnb).toMatchObject({ error: expect.stringContaining("No approved tax rule covers FNB") });
    const old = await previewTax(app, owner, { category: "ROOM", tariffMinor: 500_000, nights: 1, inclusive: false, date: "2025-09-21" });
    expect(old).toMatchObject({ error: expect.stringContaining("No approved tax rule") }); // the old slabs were not added
    await expect(previewTax(app, as(owner, "FRONT_DESK"), { category: "ROOM", tariffMinor: 1, date: day })).rejects.toThrow(/permission/i);
  });

  it("needs a second person to approve, then prices real bookings by tariff band", async () => {
    const rules = (await listRules(app, owner)).filter((r) => r.status === "DRAFT");
    await expect(approveRule(app, owner, rules[0].id)).rejects.toThrow(/different authorised user/);
    for (const r of rules) await approveRule(app, approver, r.id);
    const s = await gstSetupStatus(app, owner);
    expect(s.draftRules).toBe(0);
    expect(s.accommodation.map((a) => a.covered)).toEqual([true, true, true, true, true]);

    const lowType = (await createRoomType(app, owner, { name: "Std", maxAdults: 2, baseRateMinor: 750_000 })).id;
    const highType = (await createRoomType(app, owner, { name: "Lux", maxAdults: 2, baseRateMinor: 750_100 })).id;
    await createRoom(app, owner, { roomTypeId: lowType, number: "1" });
    await createRoom(app, owner, { roomTypeId: highType, number: "2" });
    const arrival = addDays(today, 3) < "2025-09-22" ? "2025-09-22" : addDays(today, 3);
    const q = (roomTypeId: string) => quoteStay(app, owner, { roomTypeId, arrival, departure: addDays(arrival, 1), adults: 1 });
    const a = await q(lowType);
    expect(a).toMatchObject({ subtotalMinor: 750_000, taxMinor: 37_500, totalMinor: 787_500 }); // ₹7,500: 5%
    const b = await q(highType);
    expect(b).toMatchObject({ subtotalMinor: 750_100, taxMinor: 135_018 }); // above ₹7,500: 18%
  });

  it("confirms only with the accountant tick and complete details, and records who and when", async () => {
    await expect(confirmGstSetup(app, owner, { reviewed: false })).rejects.toThrow(/Tick the box/);
    const done = await confirmGstSetup(app, owner, { reviewed: true });
    expect(done.by).toBe("Owner");
    expect(await gstWarning(app, owner)).toBeNull();
    const s = await gstSetupStatus(app, owner);
    expect(s).toMatchObject({ confirmedBy: "Owner" });
    expect(s.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await admin.auditLog.count({ where: { tenantId: owner.tenantId, action: "tax.setup_confirmed" } })).toBe(1);
  });

  it("refuses confirmation while registration details are missing, and is limited to the business and to tax staff", async () => {
    await updateGstSettings(app, other, { gstRegistered: false, invoicePrefix: "OT" }, "setup");
    await admin.property.update({ where: { id: other.propertyId! }, data: { gstRegistered: true, gstin: null } });
    await expect(confirmGstSetup(app, other, { reviewed: true })).rejects.toThrow(/Complete these first.*GSTIN/);
    expect((await listRules(app, other)).length).toBe(0); // nothing leaked from the other business
    await expect(gstSetupStatus(app, as(owner, "HOUSEKEEPING"))).rejects.toThrow(/permission/i);
    await expect(applyPreset(app, as(owner, "FRONT_DESK"), "accommodation-2025")).rejects.toThrow(/permission/i);
  });
});

function as(c: Ctx, role: Ctx["role"]): Ctx { return { ...c, role, extra: [], userId: randomUUID() }; }
