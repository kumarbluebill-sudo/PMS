import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createBooking } from "@/server/services/booking";
import { checkIn, confirmReservation } from "@/server/services/reservations";
import { modifyReservation, previewModification, reservationChecklist } from "@/server/services/confirmation";
import { updateCategory } from "@/server/services/property";
import { setSettings } from "@/server/services/settings";
import { propertyToday } from "@/server/services/roomBlocks";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let typeId: string;
let n = 0;
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const as = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });

async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `cf-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
const book = async (from: number, to: number, extra: Record<string, unknown> = {}) =>
  (await createBooking(app, owner, { newGuest: { name: `Cf Guest ${++n}`, mobile: `9400${String(100000 + n)}` }, roomTypeId: typeId, arrival: addDays(today, from), departure: addDays(today, to), adults: 2, ...extra })).reservations[0];

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = await propertyToday(app, owner);
  typeId = (await createRoomType(app, owner, { name: "CF", maxAdults: 3, maxChildren: 1, baseRateMinor: 200_000 })).id;
  for (const num of ["1", "2", "3"]) await createRoom(app, owner, { roomTypeId: typeId, number: num });
});
afterAll(async () => { await app.$disconnect(); await admin.$disconnect(); });

describe("confirmation checklist", () => {
  it("lists what is ready and what is only a warning, and lets a complete held booking be confirmed", async () => {
    const r = await book(5, 7, { status: "TENTATIVE" });
    const c = await reservationChecklist(app, owner, r.id);
    expect(c.canConfirm).toBe(true);
    expect(c.items.find((i) => i.key === "room")).toMatchObject({ ok: true });
    expect(c.warnings.map((w) => w.key)).toContain("policy"); // no cancellation policy set yet
    const confirmed = await confirmReservation(app, owner, r.id);
    expect(confirmed.status).toBe("CONFIRMED");
  });

  it("refuses to confirm when a blocker exists, and says why", async () => {
    const r = await book(8, 10, { status: "TENTATIVE" });
    await admin.roomAssignment.updateMany({ where: { reservationId: r.id }, data: { active: false } });
    const c = await reservationChecklist(app, owner, r.id);
    expect(c.canConfirm).toBe(false);
    expect(c.blockers.map((b) => b.key)).toEqual(["room"]);
    await expect(confirmReservation(app, owner, r.id)).rejects.toThrow(/No room is held/);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("TENTATIVE");
  });
});

describe("changing a booking", () => {
  it("previews the new total, then saves dates and guests, moving the room's assignment too", async () => {
    const r = await book(12, 14);
    const before = r.quotedTotalMinor!;
    const q = { arrival: addDays(today, 12), departure: addDays(today, 15), adults: 3, children: 0 };
    const p = await previewModification(app, owner, r.id, q);
    expect(p).toMatchObject({ policy: "KEEP_RATE", nights: 3, oldTotalMinor: before });
    expect(p.newTotalMinor).toBeGreaterThan(before);
    expect(p.differenceMinor).toBe(p.newTotalMinor - before);
    const saved = await modifyReservation(app, owner, r.id, { ...q, reason: "Guest extended and brought a friend" });
    expect(saved.newTotalMinor).toBe(p.newTotalMinor);
    const row = await admin.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ adults: 3, quotedTotalMinor: p.newTotalMinor });
    expect(row.departure.toISOString().slice(0, 10)).toBe(addDays(today, 15));
    const a = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: r.id, active: true } });
    expect(a.departure.toISOString().slice(0, 10)).toBe(addDays(today, 15));
    const log = await admin.auditLog.findFirstOrThrow({ where: { entityId: r.id, action: "reservation.modify" } });
    expect(log.reason).toMatch(/extended/);
    expect(JSON.stringify(log.before)).toContain("quotedTotalMinor");
  });

  it("keeps the booked rate when the category rate changes, unless the property reprices from current rates", async () => {
    const r = await book(20, 22);
    const cat = await admin.roomType.findUniqueOrThrow({ where: { id: typeId } });
    await updateCategory(app, owner, typeId, { name: cat.name, baseOccupancy: cat.baseOccupancy, maxAdults: cat.maxAdults, maxChildren: cat.maxChildren, baseRateMinor: 300_000, extraAdultRateMinor: 0, extraChildRateMinor: 0, expectedUpdatedAt: cat.updatedAt.toISOString() });
    const q = { arrival: addDays(today, 20), departure: addDays(today, 23), adults: 2, children: 0 };
    const keep = await previewModification(app, owner, r.id, q);
    expect(keep.nightly.every((x) => x.rateMinor === 200_000)).toBe(true); // the booked rate, also for the added night
    await setSettings(app, owner, { "reservation.repriceOnChange": "CURRENT_RATE" });
    const now = await previewModification(app, owner, r.id, q);
    expect(now.nightly.every((x) => x.rateMinor === 300_000)).toBe(true);
    await modifyReservation(app, owner, r.id, q);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: r.id } })).agreedRateMinor).toBe(300_000);
    await setSettings(app, owner, { "reservation.repriceOnChange": "KEEP_RATE" });
  });

  it("refuses a clash with another booking of the same room, an in-house stay, too many guests and stale edits", async () => {
    const a = await book(30, 32);
    const roomOfA = (await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: a.id, active: true } })).roomId;
    await book(33, 35, { roomId: roomOfA });
    await expect(modifyReservation(app, owner, a.id, { arrival: addDays(today, 30), departure: addDays(today, 34), adults: 2, children: 0 })).rejects.toThrow(/already booked/);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: a.id } })).departure.toISOString().slice(0, 10)).toBe(addDays(today, 32)); // nothing changed
    await expect(modifyReservation(app, owner, a.id, { arrival: addDays(today, 30), departure: addDays(today, 32), adults: 9, children: 0 })).rejects.toThrow(/takes up to/);
    const row = await admin.reservation.findUniqueOrThrow({ where: { id: a.id } });
    await admin.reservation.update({ where: { id: a.id }, data: { notes: "touched" } });
    await expect(modifyReservation(app, owner, a.id, { arrival: addDays(today, 30), departure: addDays(today, 32), adults: 2, children: 0, expectedUpdatedAt: row.updatedAt.toISOString() })).rejects.toThrow(/Someone else changed/);

    await admin.room.updateMany({ where: { tenantId: owner.tenantId }, data: { housekeeping: "CLEAN" } });
    const inHouse = await book(0, 2);
    await checkIn(app, owner, inHouse.id);
    await expect(modifyReservation(app, owner, inHouse.id, { arrival: today, departure: addDays(today, 3), adults: 2, children: 0 })).rejects.toThrow(/pending or confirmed/);
  });

  it("is limited to permitted staff and to the business", async () => {
    const r = await book(40, 42);
    const q = { arrival: addDays(today, 40), departure: addDays(today, 43), adults: 2, children: 0 };
    await expect(modifyReservation(app, as(owner, "HOUSEKEEPING"), r.id, q)).rejects.toThrow(/permission/i);
    await expect(modifyReservation(app, other, r.id, q)).rejects.toThrow(/not found|Select or create/i);
    expect(await reservationChecklist(app, other, r.id).catch((e) => e.message)).toMatch(/not found|Select or create/i);
  });
});
