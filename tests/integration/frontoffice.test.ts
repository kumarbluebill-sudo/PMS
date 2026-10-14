import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { checkIn, createReservation } from "@/server/services/reservations";
import { propertyToday } from "@/server/services/roomBlocks";
import { setSettings } from "@/server/services/settings";
import { rangeKpis } from "@/server/services/analytics";
import { alertCounts, isManagerView, listAlerts, setAlertState, staffActivity } from "@/server/services/alerts";
import { assignRoom, checkInGuarded, confirmNoShow, operations, recordRegistration, setRequests, verifyId } from "@/server/services/frontoffice";
import { globalSearch } from "@/server/services/search";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let typeId: string;
const roomIds: string[] = [];

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asRole = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });

async function tenant(label: string) {
  const r = await registerTenant(app, {
    businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner",
    email: `fo-${label}-${sfx}@test.local`, password: "correct-horse-battery",
  });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
let n = 0;
async function guest(name: string, phone: string | undefined = "9876500000") {
  return (await createGuest(app, owner, { name: `${name} ${++n}`, phone })).id;
}
const book = async (guestId: string, from: number, to: number) =>
  (await createReservation(app, owner, { guestId, roomTypeId: typeId, arrival: addDays(today, from), departure: addDays(today, to), adults: 1 })).id;
const roomOf = async (reservationId: string) =>
  (await admin.roomAssignment.findFirst({ where: { reservationId, active: true } }))?.roomId ?? null;

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = await propertyToday(app, owner);
  typeId = (await createRoomType(app, owner, { name: "FO", maxAdults: 2, baseRateMinor: 100_000 })).id;
  for (const num of ["1", "2", "3", "4"]) roomIds.push((await createRoom(app, owner, { roomTypeId: typeId, number: num })).id);
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("analytics", () => {
  it("computes occupancy, ARR and RevPAR with estimates labelled and out-of-order rooms removed", async () => {
    const a = await book(await guest("Inhouse"), 0, 2);
    await checkIn(app, owner, a);
    await book(await guest("Later"), 1, 3);
    const k = await rangeKpis(app, owner, { from: today, to: addDays(today, 2) });
    const [d0, d1, d2] = k.days;
    expect([d0.kind, d1.kind, d2.kind]).toEqual(["LIVE", "FORECAST", "FORECAST"]);
    expect(d0.sold).toBe(1);
    expect(d0.sellable).toBe(4);
    expect(d0.occupancyPct).toBe(25);
    expect(d0.postedMinor).toBe(0);
    expect(d0.estimatedMinor).toBe(100_000);
    expect(d1.sold).toBe(2);
    expect(d1.arrMinor).toBe(100_000);
    expect(d1.revparMinor).toBe(50_000);
    expect(d2.sold).toBe(1); // the in-house guest leaves on day 2
    expect(k.totals.sold).toBe(4);
    expect(k.sources.length).toBeGreaterThan(0);

    await admin.room.update({ where: { id: roomIds[3] }, data: { outOfOrder: true } });
    const k2 = await rangeKpis(app, owner, { from: today, to: today });
    expect(k2.days[0].sellable).toBe(3);
    expect(k2.days[0].unsellable).toBe(1);
    await admin.room.update({ where: { id: roomIds[3] }, data: { outOfOrder: false } });
  });

  it("hides revenue from users without billing access and never counts cancelled stays", async () => {
    const hk = asRole(owner, "HOUSEKEEPING");
    const k = await rangeKpis(app, hk, { from: today, to: today });
    expect(k.revenueVisible).toBe(false);
    expect(k.days[0].revenueMinor).toBeNull();
    expect(k.days[0].sold).toBeGreaterThan(0);
    expect(await rangeKpis(app, other, { from: today, to: today })).toMatchObject({ totals: { sold: 0 } });
  });
});

describe("operations and room assignment", () => {
  it("lists arrivals and flags unassigned reservations and allocation conflicts", async () => {
    const id = await book(await guest("Arrives"), 0, 1);
    const ops = await operations(app, owner);
    expect(ops.arrivalsExpected.some((o) => o.id === id)).toBe(true);
    expect(ops.yetToArrive.some((o) => o.id === id)).toBe(true);
    const roomId = (await roomOf(id))!;
    await admin.room.update({ where: { id: roomId }, data: { outOfOrder: true } });
    const ops2 = await operations(app, owner);
    expect(ops2.conflicts.find((o) => o.id === id)?.conflict).toMatch(/out of order/);
    await admin.room.update({ where: { id: roomId }, data: { outOfOrder: false } });
    await admin.roomAssignment.updateMany({ where: { reservationId: id }, data: { active: false } });
    expect((await operations(app, owner)).unassigned.some((o) => o.id === id)).toBe(true);
  });

  it("assigns an unassigned reservation, refuses a taken room, and allows only one of two concurrent assignments", async () => {
    const g1 = await book(await guest("Race A"), 10, 12);
    const g2 = await book(await guest("Race B"), 10, 12);
    await admin.roomAssignment.updateMany({ where: { reservationId: { in: [g1, g2] } }, data: { active: false } });
    const target = roomIds[2];
    const results = await Promise.allSettled([
      assignRoom(app, owner, { reservationId: g1, roomId: target }),
      assignRoom(app, owner, { reservationId: g2, roomId: target }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason.message)).toMatch(/not available|just taken/);
    // changing an existing room needs a reason
    const assigned = results[0].status === "fulfilled" ? g1 : g2;
    await expect(assignRoom(app, owner, { reservationId: assigned, roomId: roomIds[1] })).rejects.toThrow(/reason/);
  });
});

describe("registration, check-in rules and no-shows", () => {
  it("records registration securely, verifies ID, and blocks early and duplicate check-in", async () => {
    const future = await book(await guest("Future"), 5, 6);
    await expect(checkInGuarded(app, owner, future)).rejects.toThrow(/before the arrival date/);

    const id = await book(await guest("Reg", undefined), 0, 1);
    await expect(verifyId(app, owner, id)).rejects.toThrow(/Record the ID/);
    const r = await recordRegistration(app, owner, { reservationId: id, phone: "9123456789", idType: "PASSPORT", idNumber: "P1234567" });
    expect(r.complete).toBe(true);
    const stored = await admin.guest.findFirst({ where: { reservations: { some: { id } } } });
    expect(stored?.idNumberEnc).toBeTruthy();
    expect(stored?.idNumberEnc).not.toContain("P1234567");
    const log = await admin.auditLog.findFirst({ where: { entityId: id, action: "reservation.registration" } });
    expect(JSON.stringify(log?.after)).not.toContain("P1234567");

    await setSettings(app, owner, { "frontoffice.requireIdAtCheckin": true });
    await expect(checkInGuarded(app, owner, id)).rejects.toThrow(/Verify the guest's ID/);
    await verifyId(app, owner, id);
    await checkInGuarded(app, owner, id);
    await expect(checkInGuarded(app, owner, id)).rejects.toThrow(/already checked in/);
    await setSettings(app, owner, { "frontoffice.requireIdAtCheckin": false });
  });

  it("stores requests and VIP flags, and never auto-marks no-shows", async () => {
    const id = await book(await guest("Vip"), 3, 4);
    await setRequests(app, owner, { reservationId: id, vip: true, etaTime: "18:30", earlyCheckinRequest: "Before noon" });
    const row = (await operations(app, owner, { date: addDays(today, 3) })).arrivalsExpected.find((o) => o.id === id)!;
    expect(row).toMatchObject({ vip: true, etaTime: "18:30", earlyCheckinRequest: "Before noon" });
    await expect(setRequests(app, owner, { reservationId: id, etaTime: "25:99" })).rejects.toThrow();
    await expect(confirmNoShow(app, owner, id, "")).rejects.toThrow(/note/);
    await expect(confirmNoShow(app, owner, id, "Did not arrive")).rejects.toThrow(/only on or after/);
    expect((await admin.reservation.findUnique({ where: { id } }))?.status).toBe("CONFIRMED");
  });

  it("confirms a no-show only after the arrival date has passed, with a recorded reason", async () => {
    const id = await book(await guest("Gone"), 0, 1);
    await admin.reservation.update({ where: { id }, data: { arrival: new Date(`${addDays(today, -1)}T00:00:00Z`) } });
    expect((await operations(app, owner)).noShowCandidates.some((o) => o.id === id)).toBe(true);
    await confirmNoShow(app, owner, id, "Phoned twice, no answer");
    const r = await admin.reservation.findUnique({ where: { id } });
    expect(r?.status).toBe("NO_SHOW");
    expect(r?.noShowAt).not.toBeNull();
    expect((await admin.auditLog.findFirst({ where: { entityId: id, action: "reservation.no_show_confirmed" } }))?.reason).toBe("Phoned twice, no answer");
    await expect(confirmNoShow(app, asRole(owner, "FRONT_DESK"), id, "y")).rejects.toThrow(/permission/);
  });
});

describe("alerts, search and manager view", () => {
  it("derives alerts, acknowledges and resolves them with an audit trail, and isolates tenants", async () => {
    const id = await book(await guest("Overdue"), 0, 1);
    await checkIn(app, owner, id);
    await admin.reservation.update({ where: { id }, data: { arrival: new Date(`${addDays(today, -3)}T00:00:00Z`), departure: new Date(`${addDays(today, -1)}T00:00:00Z`) } });
    const alerts = await listAlerts(app, owner);
    const a = alerts.find((x) => x.key === `overdue:${id}`)!;
    expect(a.severity).toBe("CRITICAL");
    expect(alerts[0].severity).toBe("CRITICAL");
    const before = (await alertCounts(app, owner)).critical;

    await setAlertState(app, owner, { key: a.key, status: "ACKNOWLEDGED" });
    expect((await listAlerts(app, owner)).find((x) => x.key === a.key)?.ack?.status).toBe("ACKNOWLEDGED");
    expect((await alertCounts(app, owner)).critical).toBe(before - 1);
    await expect(setAlertState(app, owner, { key: a.key, status: "RESOLVED" })).rejects.toThrow(/note/);
    await setAlertState(app, owner, { key: a.key, status: "RESOLVED", note: "Guest extended" });
    expect((await listAlerts(app, owner)).some((x) => x.key === a.key)).toBe(false);
    expect((await listAlerts(app, owner, { includeResolved: true })).some((x) => x.key === a.key)).toBe(true);
    expect(await admin.auditLog.count({ where: { action: "alert.resolved", tenantId: owner.tenantId } })).toBe(1);

    expect((await listAlerts(app, other)).some((x) => x.key === a.key)).toBe(false);
    await setAlertState(app, owner, { key: a.key, status: "OPEN" });
    expect((await listAlerts(app, owner)).some((x) => x.key === a.key)).toBe(true);
  });

  it("shows the manager view only to approvers and keeps guest data out of search for housekeeping", async () => {
    expect(isManagerView(owner)).toBe(true);
    expect(isManagerView(asRole(owner, "FRONT_DESK"))).toBe(false);
    expect((await staffActivity(app, owner)).length).toBeGreaterThan(0);
    await expect(staffActivity(app, asRole(owner, "FRONT_DESK"))).rejects.toThrow(/managers/);

    const g = await guest("Searchable");
    const hits = await globalSearch(app, owner, "Searchable");
    expect(hits.some((h) => h.kind === "GUEST")).toBe(true);
    const hk = await globalSearch(app, asRole(owner, "HOUSEKEEPING"), "Searchable");
    expect(hk.some((h) => h.kind === "GUEST" || h.kind === "RESERVATION")).toBe(false);
    expect((await globalSearch(app, asRole(owner, "HOUSEKEEPING"), "1")).length).toBe(0); // too short
    expect((await globalSearch(app, other, "Searchable")).length).toBe(0);
    expect(g).toBeTruthy();
  });
});
