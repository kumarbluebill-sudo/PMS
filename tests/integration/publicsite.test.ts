import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { exportAllData } from "@/server/services/dataExport";
import { createLead, listPublicPlans } from "@/server/services/publicSite";
import { adminAction, savePlatformSettings, type PlatformCtx } from "@/server/services/platform";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
const root: PlatformCtx = { userId: randomUUID(), role: "PLATFORM_SUPER_ADMIN", requestId: "t" };

const good = { name: "Asha Rao", hotel: "Sea View Inn", mobile: "98765 43210", email: "asha@seaview.test", rooms: "24", properties: "1" };
const visitor = () => `ip-${randomUUID()}`;

beforeAll(() => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
});
afterAll(async () => {
  await admin.plan.deleteMany({ where: { code: { in: [`hidden-${sfx}`, `off-${sfx}`] } } });
  await app.$disconnect();
  await admin.$disconnect();
});

describe("pricing is read from the plans table", () => {
  it("shows a price changed in the database straight away", async () => {
    const before = (await listPublicPlans(app)).plans.find((p) => p.code === "starter")!;
    try {
      await admin.plan.update({ where: { code: "starter" }, data: { monthlyPriceMinor: 123_400 } });
      const after = (await listPublicPlans(app)).plans.find((p) => p.code === "starter")!;
      expect(after.monthlyPriceMinor).toBe(123_400);
    } finally {
      await admin.plan.update({ where: { code: "starter" }, data: { monthlyPriceMinor: before.monthlyPriceMinor } });
    }
  });
  it("hides inactive and non-public plans and returns the tax rate", async () => {
    await admin.plan.create({ data: { code: `hidden-${sfx}`, name: "Hidden", isPublic: false, monthlyPriceMinor: 1 } });
    await admin.plan.create({ data: { code: `off-${sfx}`, name: "Off", active: false, monthlyPriceMinor: 1 } });
    const r = await listPublicPlans(app);
    expect(r.plans.map((p) => p.code)).not.toContain(`hidden-${sfx}`);
    expect(r.plans.map((p) => p.code)).not.toContain(`off-${sfx}`);
    expect(r.plans.map((p) => p.code).slice(0, 4)).toEqual(["starter", "professional", "growth", "enterprise"]);
    expect(r.gstBps).toBeGreaterThanOrEqual(0);
  });
});

describe("contact and demo requests", () => {
  it("stores a valid request and normalises the mobile number", async () => {
    const r = await createLead(app, { ...good, kind: "DEMO" }, visitor());
    expect(r.stored).toBe(true);
    const row = await admin.lead.findFirstOrThrow({ where: { email: "asha@seaview.test" }, orderBy: { createdAt: "desc" } });
    expect([row.kind, row.name, row.hotel, row.mobile, row.rooms, row.properties, row.status]).toEqual(["DEMO", "Asha Rao", "Sea View Inn", "9876543210", 24, 1, "NEW"]);
    expect(row.ipHash).toBeTruthy();
    expect(row.ipHash).not.toContain("ip-");
  });

  it("rejects missing or malformed details", async () => {
    await expect(createLead(app, { ...good, mobile: "12345" }, visitor())).rejects.toThrow();
    await expect(createLead(app, { ...good, email: "not-an-email" }, visitor())).rejects.toThrow();
    await expect(createLead(app, { ...good, name: "" }, visitor())).rejects.toThrow();
    await expect(createLead(app, { ...good, rooms: "99999" }, visitor())).rejects.toThrow();
    await expect(createLead(app, { ...good, message: "x".repeat(2001) }, visitor())).rejects.toThrow();
  });

  it("drops a request whose hidden field is filled in, without storing it", async () => {
    const before = await admin.lead.count();
    const r = await createLead(app, { ...good, website: "http://spam.example" }, visitor());
    expect(r.stored).toBe(false);
    expect(await admin.lead.count()).toBe(before);
  });

  it("limits how often one visitor can send", async () => {
    const v = visitor();
    for (let i = 0; i < 5; i++) await createLead(app, good, v);
    await expect(createLead(app, good, v)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("emails the sales address once when one is set", async () => {
    const to = `sales-${sfx}@test.local`;
    await savePlatformSettings(app, root, { "saas.salesEmail": to });
    try {
      const r = await createLead(app, { ...good, hotel: `Mailed ${sfx}` }, visitor());
      if (!r.stored) throw new Error("not stored");
      const mails = await admin.emailOutbox.findMany({ where: { toEmail: to, idempotencyKey: `lead:${r.id}` } });
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toContain(`Mailed ${sfx}`);
    } finally {
      await savePlatformSettings(app, root, { "saas.salesEmail": "" });
    }
  });
});

describe("export of all data", () => {
  async function hotel(label: string): Promise<Ctx> {
    const r = await registerTenant(app, { businessName: `Exp ${label} ${sfx}`, propertyName: `Hotel ${label}`, name: "Owner", email: `exp-${label}-${sfx}@test.local`, password: "correct-horse-battery", plan: "starter" });
    return loadContext(app, { userId: r.userId, epoch: 0 });
  }

  it("exports the hotel's own data, hides ID numbers and audits it", async () => {
    const a = await hotel("a");
    const b = await hotel("b");
    const rt = await createRoomType(app, a, { name: "Std", baseRateMinor: 100_000, maxAdults: 2 });
    await createRoom(app, a, { roomTypeId: rt.id, number: "A101" });
    await createRoom(app, b, { roomTypeId: (await createRoomType(app, b, { name: "Std", baseRateMinor: 1, maxAdults: 2 })).id, number: "B101" });
    await admin.guest.create({ data: { tenantId: a.tenantId, name: "Test Guest", idNumberEnc: "SECRET-CIPHERTEXT" } });
    const { bytes, counts } = await exportAllData(app, a);
    expect(counts.Rooms).toBe(1);
    expect(counts.Guests).toBe(1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Properties", "Rooms", "Categories", "Guests", "Reservations", "Folios", "FolioEntries", "Payments", "Invoices"]);
    const rooms = wb.getWorksheet("Rooms")!;
    const numbers = rooms.getColumn(rooms.getRow(1).values ? (rooms.getRow(1).values as string[]).indexOf("number") : 1).values.slice(2);
    expect(numbers).toEqual(["A101"]);
    const guests = wb.getWorksheet("Guests")!;
    expect((guests.getRow(1).values as string[])).not.toContain("idNumberEnc");
    expect(JSON.stringify(guests.getSheetValues())).not.toContain("SECRET-CIPHERTEXT");
    expect(await admin.auditLog.count({ where: { tenantId: a.tenantId, action: "data.export_all" } })).toBe(1);
  });

  it("still works when the subscription has lapsed, and needs the export permission", async () => {
    const c = await hotel("c");
    await adminAction(app, root, { action: "SUSPEND", tenantId: c.tenantId, reason: "Unpaid" });
    const ro = await loadContext(app, { userId: c.userId, epoch: 0 });
    expect(ro.readOnly).toBe(true);
    await expect(exportAllData(app, ro)).resolves.toBeTruthy();
    await expect(exportAllData(app, { ...ro, role: "FRONT_DESK", extra: [] })).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});
