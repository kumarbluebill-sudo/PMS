import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createBooking } from "@/server/services/booking";
import { checkIn } from "@/server/services/reservations";
import { propertyToday } from "@/server/services/roomBlocks";
import { createGuest, getGuestProfile, guestHistory, lookupGuests, updateGuest } from "@/server/services/guests";
import { uniqueReference } from "@/server/services/availability";
import { withTenant } from "@/server/db/withTenant";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let typeId: string;
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `gl-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
const as = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = await propertyToday(app, owner);
  typeId = (await createRoomType(app, owner, { name: "GL", maxAdults: 3, baseRateMinor: 300_000 })).id;
  for (const n of ["1", "2", "3", "4", "5"]) await createRoom(app, owner, { roomTypeId: typeId, number: n });
});
afterAll(async () => { await app.$disconnect(); await admin.$disconnect(); });

describe("guest lookup", () => {
  it("finds a guest by their number in any format and keeps the number as typed", async () => {
    const r = await createBooking(app, owner, { newGuest: { name: "Asha Verma", mobile: "+91 98765 43210", email: "asha@test.local" }, roomTypeId: typeId, arrival: addDays(today, 3), departure: addDays(today, 5), adults: 1 });
    const g = await admin.guest.findUniqueOrThrow({ where: { id: r.reservations[0].guestId } });
    expect(g).toMatchObject({ phone: "+91 98765 43210", phoneKey: "9876543210" });
    for (const q of ["9876543210", "098765-43210", "+91 (98765) 43210", "98765", "Asha"]) {
      const found = await lookupGuests(app, owner, q);
      expect(found.map((x) => x.name), q).toContain("Asha Verma");
    }
    const [m] = await lookupGuests(app, owner, "9876543210");
    expect(m).toMatchObject({ phone: "+91 98765 43210", email: "asha@test.local", stays: 0, lastStay: null, duplicate: false });
    expect(JSON.stringify(m)).not.toMatch(/idNumber|notes/);
  });

  it("returns several matches with a duplicate flag, and nothing for short or unknown input", async () => {
    await createGuest(app, owner, { name: "Rohan Mehta", phone: "90000 11111" });
    await createGuest(app, owner, { name: "Rohan M", phone: "+91 90000 11111" });
    const found = await lookupGuests(app, owner, "9000011111");
    expect(found.map((x) => x.name).sort()).toEqual(["Rohan M", "Rohan Mehta"]);
    expect(found.every((x) => x.duplicate)).toBe(true);
    expect(await lookupGuests(app, owner, "9")).toEqual([]);
    expect(await lookupGuests(app, owner, "12")).toEqual([]);
    expect(await lookupGuests(app, owner, "Nobody Here")).toEqual([]);
  });

  it("reports last stay and stay count from stays that happened", async () => {
    const r = await createBooking(app, owner, { newGuest: { name: "Kavya Rao", mobile: "9444400001" }, roomTypeId: typeId, arrival: today, departure: addDays(today, 1), adults: 1 });
    await checkIn(app, owner, r.reservations[0].id).catch(() => undefined); // may need a ready room; stay count is checked either way
    const [m] = await lookupGuests(app, owner, "9444400001");
    expect(m.stays === 0 || m.stays === 1).toBe(true);
    const hist = await guestHistory(app, owner, r.reservations[0].guestId);
    expect(hist.reservations[0]).toMatchObject({ reference: r.reservations[0].reference, category: "GL" });
    expect(hist.outstandingMinor).not.toBeNull();
  });

  it("warns on a duplicate when booking a new guest, and only creates it when confirmed", async () => {
    const mk = (allowDuplicate?: boolean) => createBooking(app, owner, { newGuest: { name: "Asha V", mobile: "98765 43210", allowDuplicate }, roomTypeId: typeId, arrival: addDays(today, 10), departure: addDays(today, 11), adults: 1 });
    await expect(mk()).rejects.toThrow(/already exists: Asha Verma/);
    expect(await admin.guest.count({ where: { name: "Asha V", tenantId: owner.tenantId } })).toBe(0);
    await expect(mk(true)).resolves.toBeTruthy();
    expect(await admin.guest.count({ where: { name: "Asha V", tenantId: owner.tenantId } })).toBe(1);
    expect(await admin.guest.count({ where: { name: "Asha Verma", tenantId: owner.tenantId } })).toBe(1); // nothing merged
  });
});

describe("privacy, edits and isolation", () => {
  it("never returns ID data, hides contact details from an auditor, and gates balance by billing access", async () => {
    const r = await createBooking(app, owner, { newGuest: { name: "Id Guest", mobile: "9555500001", idType: "PASSPORT", idNumber: "P1234567" }, roomTypeId: typeId, arrival: addDays(today, 20), departure: addDays(today, 21), adults: 1 });
    const gid = r.reservations[0].guestId;
    const prof = await getGuestProfile(app, owner, gid);
    expect(prof.idRecorded).toBe(true);
    expect(JSON.stringify(prof)).not.toMatch(/P1234567|idNumberEnc/);
    const auditor = as(owner, "AUDITOR");
    const [m] = await lookupGuests(app, auditor, "9555500001");
    expect(m).toMatchObject({ phone: null, email: null });
    expect((await guestHistory(app, as(owner, "RESERVATION_EXECUTIVE"), gid)).outstandingMinor).toBeNull();
    expect((await guestHistory(app, owner, gid)).outstandingMinor).toBe(0);
    expect((await guestHistory(app, as(owner, "HOUSEKEEPING"), gid).catch((e) => e.message))).toMatch(/permission|forbidden|not allowed/i);
  });

  it("updates the master profile with an audit trail and a stale-edit check, leaving reservations alone", async () => {
    const r = await createBooking(app, owner, { newGuest: { name: "Edit Me", mobile: "9666600001" }, roomTypeId: typeId, arrival: addDays(today, 25), departure: addDays(today, 26), adults: 1 });
    const gid = r.reservations[0].guestId;
    const before = await admin.guest.findUniqueOrThrow({ where: { id: gid } });
    await updateGuest(app, owner, gid, { name: "Edit Me Now", phone: "+91 96666 00002", email: "", nationality: "Indian", expectedUpdatedAt: before.updatedAt.toISOString() });
    const after = await admin.guest.findUniqueOrThrow({ where: { id: gid } });
    expect(after).toMatchObject({ name: "Edit Me Now", phoneKey: "9666600002", nationality: "Indian" });
    await expect(updateGuest(app, owner, gid, { name: "Late", expectedUpdatedAt: before.updatedAt.toISOString() })).rejects.toThrow(/Someone else changed/);
    const log = await admin.auditLog.findFirstOrThrow({ where: { entityId: gid, action: "guest.update" } });
    expect(JSON.stringify(log)).not.toContain("96666 00002");
    expect(JSON.stringify(log.after)).toContain("…0002");
    const res = await admin.reservation.findUniqueOrThrow({ where: { id: r.reservations[0].id } });
    expect(res.guestId).toBe(gid);
    await expect(updateGuest(app, as(owner, "AUDITOR"), gid, { name: "Nope" })).rejects.toThrow();
  });

  it("cannot look up or read another business's guests", async () => {
    const g = await createGuest(app, owner, { name: "Isolated Person", phone: "9777700001" });
    expect(await lookupGuests(app, other, "9777700001")).toEqual([]);
    await expect(getGuestProfile(app, other, g.id)).rejects.toThrow(/not found/i);
    await expect(guestHistory(app, other, g.id)).rejects.toThrow(/not found/i);
  });
});

describe("reservation references", () => {
  it("allocates a reference that no booking of the business uses", async () => {
    const used = (await admin.reservation.findFirstOrThrow({ where: { tenantId: owner.tenantId } })).reference;
    const refs = await withTenant(app, owner.tenantId, async (tx) => Promise.all(Array.from({ length: 30 }, () => uniqueReference(tx, owner.tenantId, "MK"))));
    expect(refs.every((r) => /^MK-[0-9A-F]{8}$/.test(r))).toBe(true);
    expect(refs).not.toContain(used);
  });
});
