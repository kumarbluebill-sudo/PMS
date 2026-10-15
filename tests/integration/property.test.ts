import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createGuest } from "@/server/services/guests";
import { createBooking, quoteStay } from "@/server/services/booking";
import { postRoomNights } from "@/server/services/billing";
import { cancelReservation, createReservation } from "@/server/services/reservations";
import { propertyToday } from "@/server/services/roomBlocks";
import { createRoom, listRooms, listRoomTypes } from "@/server/services/rooms";
import { createBuilding, createFloor, setBuildingActive, setFloorActive } from "@/server/services/structure";
import {
  archiveRoom, bulkAssignFloor, createCategoryFull, createRatePlan, createRoomsBulk, deleteCategory, deleteFloorOrBuilding, deleteProperty, deleteRatePlan, deleteRoom,
  duplicateRatePlan, getRatePlan, listRoomsAdmin, previewBulkRooms, previewRates, reactivateRoom, reassignRooms, setCategoryActive, setPropertyStatus, setRatePlanActive,
  updateCategory, updatePropertyProfile, updateRatePlan, updateRoom,
} from "@/server/services/property";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let n = 0;

const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `pm-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
const category = (name: string, extra: Record<string, unknown> = {}) =>
  createCategoryFull(app, owner, { name, baseOccupancy: 2, maxAdults: 3, maxChildren: 1, baseRateMinor: 400_000, extraAdultRateMinor: 100_000, extraChildRateMinor: 0, ...extra });
const room = async (typeId: string, number: string) => (await createRoom(app, owner, { roomTypeId: typeId, number })).id;
const guest = async () => (await createGuest(app, owner, { name: `Guest ${++n}`, phone: "9876500002" })).id;
const book = async (typeId: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
  (await createReservation(app, owner, { guestId: await guest(), roomTypeId: typeId, arrival: addDays(today, from), departure: addDays(today, to), adults: 2, ...extra })).id;
const plan = (typeId: string, over: Record<string, unknown> = {}) => ({
  name: "Seasonal", code: `S${++n}`, priority: 0, rates: [{ roomTypeId: typeId, weekdayRateMinor: 500_000 }], ...over,
});

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = await propertyToday(app, owner);
});
afterAll(async () => { await app.$disconnect(); await admin.$disconnect(); });

describe("categories", () => {
  it("rejects duplicate names and codes, and a standard occupancy above the maximum", async () => {
    const a = await category("Deluxe", { code: "dlx" });
    expect(a.code).toBe("DLX");
    await expect(category("deluxe")).rejects.toThrow(/already exists/);
    await expect(category("Other", { code: "DLX" })).rejects.toThrow(/already used/);
    await expect(category("Wide", { baseOccupancy: 5, maxAdults: 2 })).rejects.toThrow(/cannot exceed/);
    await expect(category("Photos", { imageUrls: ["http://x.test/a.jpg"] })).rejects.toThrow(/https/);
  });

  it("edits a category, audits rate changes, and detects a stale form", async () => {
    const t = await category("Edit Me");
    const u = await updateCategory(app, owner, t.id, { name: "Edited", baseOccupancy: 2, maxAdults: 3, maxChildren: 1, baseRateMinor: 450_000, extraAdultRateMinor: 0, extraChildRateMinor: 0, expectedUpdatedAt: t.updatedAt.toISOString() });
    expect(u.baseRateMinor).toBe(450_000);
    await expect(updateCategory(app, owner, t.id, { name: "Late", baseOccupancy: 2, maxAdults: 3, maxChildren: 1, baseRateMinor: 1, extraAdultRateMinor: 0, extraChildRateMinor: 0, expectedUpdatedAt: t.updatedAt.toISOString() })).rejects.toThrow(/Someone else changed/);
    const log = await admin.auditLog.findFirst({ where: { entityId: t.id, action: "roomType.update" } });
    expect(log?.reason).toMatch(/keep the rate/);
  });

  it("deactivates, hides from booking, reassigns rooms safely, and blocks deletion while used", async () => {
    const from = await category("From");
    const to = await category("To");
    const free = await room(from.id, `F${++n}`);
    const busy = await room(from.id, `F${++n}`);
    await book(from.id, 3, 5, {});
    const live = await admin.roomAssignment.findFirstOrThrow({ where: { room: { roomTypeId: from.id }, active: true } });
    const busyId = live.roomId === busy ? busy : live.roomId;
    await expect(reassignRooms(app, owner, { fromTypeId: from.id, toTypeId: to.id, roomIds: [busyId] })).rejects.toThrow(/current or future bookings/);
    const freeId = busyId === free ? busy : free;
    expect((await reassignRooms(app, owner, { fromTypeId: from.id, toTypeId: to.id, roomIds: [freeId] })).moved).toBe(1);
    await expect(deleteCategory(app, owner, from.id)).rejects.toThrow(/cannot be deleted/);
    await expect(setCategoryActive(app, owner, from.id, false, "")).rejects.toThrow(/reason/);
    await setCategoryActive(app, owner, from.id, false, "Retired");
    expect((await listRoomTypes(app, owner)).some((x) => x.id === from.id)).toBe(false);
    await expect(createRoom(app, owner, { roomTypeId: from.id, number: `X${++n}` })).rejects.toThrow(/inactive/);
    await expect(quoteStay(app, owner, { roomTypeId: from.id, arrival: addDays(today, 20), departure: addDays(today, 21) })).rejects.toThrow(/not open/);
    await setCategoryActive(app, owner, from.id, true);
    const empty = await category("Empty");
    await deleteCategory(app, owner, empty.id);
  });
});

describe("rooms", () => {
  it("rejects duplicate numbers, edits, assigns floors and bulk-creates with a preview", async () => {
    const t = await category("Rooms Cat");
    const r1 = await room(t.id, "R100");
    await expect(room(t.id, "R100")).rejects.toThrow(/already exists/);
    const b = await createBuilding(app, owner, { name: `Tower ${++n}` });
    const f = await createFloor(app, owner, { buildingId: b.id, label: "Floor 1", level: 1 });
    const cur = await admin.room.findUniqueOrThrow({ where: { id: r1 } });
    await updateRoom(app, owner, r1, { number: "R100", name: "Corner", roomTypeId: t.id, floorId: f.id, expectedUpdatedAt: cur.updatedAt.toISOString() });
    const edited = await admin.room.findUniqueOrThrow({ where: { id: r1 } });
    expect(edited).toMatchObject({ name: "Corner", floorId: f.id, buildingId: b.id, floor: 1 });
    await expect(updateRoom(app, owner, r1, { number: "R100", roomTypeId: t.id, expectedUpdatedAt: cur.updatedAt.toISOString() })).rejects.toThrow(/Someone else changed/);

    const p = await previewBulkRooms(app, owner, { roomTypeId: t.id, floorId: f.id, prefix: "R", from: 100, to: 103 });
    expect(p.numbers).toEqual(["R100", "R101", "R102", "R103"]);
    expect(p.taken).toEqual(["R100"]);
    await expect(createRoomsBulk(app, owner, { roomTypeId: t.id, prefix: "R", from: 100, to: 103 })).rejects.toThrow(/already exist/);
    expect(await admin.room.count({ where: { number: "R101", propertyId: owner.propertyId! } })).toBe(0);
    expect((await createRoomsBulk(app, owner, { roomTypeId: t.id, floorId: f.id, prefix: "R", from: 101, to: 103 })).created).toBe(3);
    await expect(previewBulkRooms(app, owner, { roomTypeId: t.id, from: 5, to: 1 })).rejects.toThrow(/must not be below/);
    await expect(previewBulkRooms(app, owner, { roomTypeId: t.id, from: 1, to: 500 })).rejects.toThrow(/at most 200/);
    expect((await listRoomsAdmin(app, owner, { q: "R10" })).length).toBeGreaterThanOrEqual(4);
  });

  it("archives a free room, blocks archiving a booked one, keeps history, reactivates, and deletes only unused rooms", async () => {
    const t = await category("Archive Cat");
    const r1 = await room(t.id, `A${++n}`);
    const id = await book(t.id, 1, 3);
    const assigned = (await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: id } })).roomId;
    await expect(archiveRoom(app, owner, assigned, "Renovation")).rejects.toThrow(/upcoming bookings/);
    await expect(deleteRoom(app, owner, assigned)).rejects.toThrow(/cannot be deleted/);
    expect(assigned).toBe(r1);
    await cancelReservation(app, owner, id, "Guest cancelled");
    await expect(archiveRoom(app, owner, assigned, "")).rejects.toThrow(/reason/);
    await archiveRoom(app, owner, assigned, "Renovation");
    expect((await listRooms(app, owner)).some((r) => r.id === assigned)).toBe(false);
    expect((await listRoomsAdmin(app, owner, { status: "archived" })).some((r) => r.id === assigned)).toBe(true);
    // The cancelled booking still points at the archived room.
    expect(await admin.roomAssignment.count({ where: { roomId: assigned, reservationId: id } })).toBe(1);
    await reactivateRoom(app, owner, assigned);
    expect((await listRooms(app, owner)).some((r) => r.id === assigned)).toBe(true);
    const fresh = await room(t.id, `A${++n}`);
    await deleteRoom(app, owner, fresh);
    expect(await admin.room.count({ where: { id: fresh } })).toBe(0);
  });

  it("an archived room is not offered for new bookings", async () => {
    const t = await category("Solo Cat");
    const only = await room(t.id, `S${++n}`);
    await archiveRoom(app, owner, only, "Out of service");
    await expect(book(t.id, 2, 3)).rejects.toThrow(/No room of this type/);
  });
});

describe("floors", () => {
  it("blocks deactivation while active rooms remain, allows it once empty, and deletes only empty floors", async () => {
    const t = await category("Floor Cat");
    const b = await createBuilding(app, owner, { name: `Wing ${++n}` });
    const f = await createFloor(app, owner, { buildingId: b.id, label: "Floor 2", level: 2 });
    const r = await room(t.id, `FL${++n}`);
    const prev = await bulkAssignFloor(app, owner, { floorId: f.id, roomIds: [r], dryRun: true });
    expect(prev.applied).toBe(false);
    expect(await admin.room.findUniqueOrThrow({ where: { id: r } }).then((x) => x.floorId)).toBeNull();
    await bulkAssignFloor(app, owner, { floorId: f.id, roomIds: [r] });
    await expect(setFloorActive(app, owner, f.id, false)).rejects.toThrow(/still assigned/);
    await expect(setBuildingActive(app, owner, b.id, false)).rejects.toThrow(/still assigned/);
    await expect(deleteFloorOrBuilding(app, owner, "floor", f.id)).rejects.toThrow(/cannot be deleted/);
    await archiveRoom(app, owner, r, "Closed");
    await setFloorActive(app, owner, f.id, false);
    await expect(deleteFloorOrBuilding(app, owner, "floor", f.id)).rejects.toThrow(/cannot be deleted/); // archived room still references it
    const f2 = await createFloor(app, owner, { buildingId: b.id, label: "Floor 9", level: 9 });
    await deleteFloorOrBuilding(app, owner, "floor", f2.id);
    expect(await admin.floor.count({ where: { id: f2.id } })).toBe(0);
  });
});

describe("rate plans", () => {
  it("rejects same-priority overlap, allows a higher-priority seasonal plan, and previews the effective rate", async () => {
    const t = await category("Rated");
    await room(t.id, `RT${++n}`);
    const base = await createRatePlan(app, owner, plan(t.id, { name: "Standard", code: `STD${++n}`, priority: 0 }));
    await expect(createRatePlan(app, owner, plan(t.id, { name: "Clash", code: `CL${++n}`, priority: 0 }))).rejects.toThrow(/overlaps "Standard"/);
    const d0 = addDays(today, 10);
    const season = await createRatePlan(app, owner, plan(t.id, { name: "Festival", code: `FE${++n}`, priority: 5, validFrom: d0, validTo: addDays(d0, 2), rates: [{ roomTypeId: t.id, weekdayRateMinor: 900_000, weekendRateMinor: 900_000 }] }));
    const pv = await previewRates(app, owner, { from: addDays(d0, -1), days: 5 });
    const row = pv.rows.find((r) => r.type.id === t.id)!;
    expect(row.nights.map((x) => x.planName)).toEqual(["Standard", "Festival", "Festival", "Festival", "Standard"]);
    expect(row.nights.map((x) => x.rateMinor)).toEqual([500_000, 900_000, 900_000, 900_000, 500_000]);
    await expect(createRatePlan(app, owner, plan(t.id, { code: base.code, name: "Dup" }))).rejects.toThrow(/already used/);
    await expect(createRatePlan(app, owner, plan(t.id, { code: `BAD${++n}`, validFrom: "2026-12-10", validTo: "2026-12-01" }))).rejects.toThrow(/end date/);
    await expect(createRatePlan(app, owner, { ...plan(t.id), rates: [] })).rejects.toThrow(/at least one category/);

    // Booking inside the season is priced by the plan and shows the plan name.
    const q = await quoteStay(app, owner, { roomTypeId: t.id, arrival: d0, departure: addDays(d0, 2), adults: 2 });
    expect(q.rateMinor).toBe(900_000);
    expect(q.ratePlan?.name).toBe("Festival");

    const copy = await duplicateRatePlan(app, owner, season.id);
    expect(copy.active).toBe(false);
    await expect(setRatePlanActive(app, owner, copy.id, true)).rejects.toThrow(/overlaps "Festival"/);
    await deleteRatePlan(app, owner, copy.id);
  });

  it("editing a rate plan or category never reprices an existing booking or posted nights", async () => {
    const t = await category("Frozen");
    await room(t.id, `FR${++n}`);
    const p = await createRatePlan(app, owner, plan(t.id, { name: "Frozen plan", code: `FZ${++n}`, rates: [{ roomTypeId: t.id, weekdayRateMinor: 600_000 }] }));
    const res = await createBooking(app, owner, { guestId: await guest(), roomTypeId: t.id, arrival: addDays(today, 30), departure: addDays(today, 32), adults: 2 }, { allowPast: false });
    expect(res.quote.rateMinor).toBe(600_000);
    const id = res.reservations[0].id;

    const cur = await getRatePlan(app, owner, p.id);
    await updateRatePlan(app, owner, p.id, { ...plan(t.id, { name: "Frozen plan", code: p.code }), rates: [{ roomTypeId: t.id, weekdayRateMinor: 999_000 }], expectedUpdatedAt: cur.plan.updatedAt.toISOString() });
    const tt = await admin.roomType.findUniqueOrThrow({ where: { id: t.id } });
    await updateCategory(app, owner, t.id, { name: "Frozen", baseOccupancy: 2, maxAdults: 3, maxChildren: 1, baseRateMinor: 800_000, extraAdultRateMinor: 300_000, extraChildRateMinor: 0, expectedUpdatedAt: tt.updatedAt.toISOString() });

    await postRoomNights(app, owner, id);
    const entries = await admin.folioEntry.findMany({ where: { folio: { reservationId: id }, category: "ROOM", subCategory: null } });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.netMinor === 600_000)).toBe(true);
    // A later booking sees the new prices.
    const later = await quoteStay(app, owner, { roomTypeId: t.id, arrival: addDays(today, 40), departure: addDays(today, 41), adults: 2 });
    expect(later.rateMinor).toBe(999_000);
  });

  it("charges extra adults in the quote and on the folio at the booked extra-person rate", async () => {
    const t = await category("Extras", { baseOccupancy: 2, maxAdults: 4, extraAdultRateMinor: 150_000 });
    await room(t.id, `EX${++n}`);
    const q = await quoteStay(app, owner, { roomTypeId: t.id, arrival: addDays(today, 50), departure: addDays(today, 52), adults: 3 });
    expect(q.extraPersonMinor).toBe(300_000);
    expect(q.subtotalMinor).toBe(2 * (400_000 + 150_000));
    const res = await createBooking(app, owner, { guestId: await guest(), roomTypeId: t.id, arrival: addDays(today, 50), departure: addDays(today, 52), adults: 3 });
    const tt = await admin.roomType.findUniqueOrThrow({ where: { id: t.id } });
    await updateCategory(app, owner, t.id, { name: "Extras", baseOccupancy: 2, maxAdults: 4, maxChildren: 1, baseRateMinor: 400_000, extraAdultRateMinor: 999_000, extraChildRateMinor: 0, expectedUpdatedAt: tt.updatedAt.toISOString() });
    await postRoomNights(app, owner, res.reservations[0].id);
    const extra = await admin.folioEntry.findMany({ where: { folio: { reservationId: res.reservations[0].id }, subCategory: "EXTRA_PERSON" } });
    expect(extra.map((e) => e.netMinor)).toEqual([150_000, 150_000]);
  });
});

describe("property profile", () => {
  it("saves the profile, enforces a unique code, validates fields and reports stale edits", async () => {
    const prop = await admin.property.findUniqueOrThrow({ where: { id: owner.propertyId! } });
    const base = { name: "Palm Resort", timezone: "Asia/Kolkata", currency: "inr", checkInTime: "14:00", checkOutTime: "11:00", amenities: ["Pool", "Spa"], imageUrls: [] as string[] };
    const p = await updatePropertyProfile(app, owner, { ...base, code: "palm", phone: "+91 98765 43210", email: "front@palm.test", logoUrl: "https://palm.test/logo.png", expectedUpdatedAt: prop.updatedAt.toISOString() });
    expect(p).toMatchObject({ code: "PALM", currency: "INR", phone: "+91 98765 43210" });
    await expect(updatePropertyProfile(app, owner, { ...base, expectedUpdatedAt: prop.updatedAt.toISOString() })).rejects.toThrow(/Someone else changed/);
    await expect(updatePropertyProfile(app, owner, { ...base, email: "nope" })).rejects.toThrow(/valid email/);
    await expect(updatePropertyProfile(app, owner, { ...base, logoUrl: "http://x.test/l.png" })).rejects.toThrow(/https/);
    await expect(updatePropertyProfile(app, owner, { ...base, timezone: "Mars/Base" })).rejects.toThrow(/timezone/i);
    await expect(updatePropertyProfile(app, other, { ...base, code: "PALM" })).resolves.toBeTruthy(); // codes are unique per business, not global
    await expect(updatePropertyProfile(app, owner, { ...base, code: "PALM", phone: "abc" })).rejects.toThrow(/Phone/);
  });

  it("refuses to deactivate with upcoming bookings and never deletes a property with records", async () => {
    const t = await category("Prop Cat");
    await room(t.id, `P${++n}`);
    await book(t.id, 5, 6);
    await expect(setPropertyStatus(app, owner, "INACTIVE", "Closing")).rejects.toThrow(/current or upcoming/);
    await expect(deleteProperty(app, owner, owner.propertyId!)).rejects.toThrow(/cannot be deleted because it has/);
  });
});

describe("permissions and tenant isolation", () => {
  it("needs the right permission for every mutation", async () => {
    const t = await category("Perm Cat");
    const r = await room(t.id, `PM${++n}`);
    const front: Ctx = { ...owner, role: "FRONT_DESK", extra: [], userId: randomUUID() };
    const revenue: Ctx = { ...owner, role: "REVENUE_MANAGER", extra: [], userId: randomUUID() };
    await expect(archiveRoom(app, front, r, "Nope")).rejects.toThrow();
    await expect(updateCategory(app, front, t.id, { name: "X", baseOccupancy: 1, maxAdults: 1, maxChildren: 0, baseRateMinor: 1, extraAdultRateMinor: 0, extraChildRateMinor: 0 })).rejects.toThrow();
    await expect(createRatePlan(app, front, plan(t.id))).rejects.toThrow();
    await expect(updatePropertyProfile(app, revenue, { name: "Hotel", timezone: "Asia/Kolkata", currency: "INR", checkInTime: "14:00", checkOutTime: "11:00" })).rejects.toThrow();
    await expect(createRatePlan(app, revenue, plan(t.id, { code: `RV${++n}`, priority: 3 }))).resolves.toBeTruthy(); // revenue managers own rates
    await expect(archiveRoom(app, revenue, r, "Nope")).rejects.toThrow();
  });

  it("cannot read or change another business's records", async () => {
    const t = await category("Mine");
    const r = await room(t.id, `ISO${++n}`);
    const p = await createRatePlan(app, owner, plan(t.id, { code: `ISO${++n}`, priority: 7 }));
    await expect(archiveRoom(app, other, r, "Hostile")).rejects.toThrow(/not found/i);
    await expect(setCategoryActive(app, other, t.id, false, "Hostile")).rejects.toThrow(/not found/i);
    await expect(deleteRatePlan(app, other, p.id)).rejects.toThrow(/not found/i);
    await expect(getRatePlan(app, other, p.id)).rejects.toThrow(/not found/i);
    expect((await listRoomsAdmin(app, other)).some((x) => x.id === r)).toBe(false);
  });
});
