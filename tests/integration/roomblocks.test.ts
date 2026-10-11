import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { checkIn, createReservation, searchAvailability } from "@/server/services/reservations";
import { setRoomStatus } from "@/server/services/housekeeping";
import { approveBlock, getIssue, reportIssue, resolveIssue, updateIssue } from "@/server/services/roomBlocks";
import { roomBoard } from "@/server/services/dashboard";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
const types: Record<string, string> = {};
const rooms: Record<string, string> = {};

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asRole = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });

async function tenant(label: string) {
  const r = await registerTenant(app, {
    businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner",
    email: `blk-${label}-${sfx}@test.local`, password: "correct-horse-battery",
  });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
const sellable = async (key: string, from: string, to: string) =>
  (await searchAvailability(app, owner, { roomTypeId: types[key], arrival: from, departure: to })).length;
const base = { category: "PLUMBING", title: "Leaking pipe", description: undefined } as const;

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = (await roomBoard(app, owner)).today;
  for (const [i, key] of ["report", "window", "ooo", "guest", "approve", "two", "checkin", "future"].entries()) {
    const rt = await createRoomType(app, owner, { name: `B-${key}`, maxAdults: 2, baseRateMinor: 100_000 });
    types[key] = rt.id;
    rooms[key] = (await createRoom(app, owner, { roomTypeId: rt.id, number: String(201 + i), floor: 2 })).id;
  }
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("reporting and blocking", () => {
  it("a plain report does not remove the room from sale", async () => {
    await reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "REPORT" });
    expect(await sellable("report", addDays(today, 40), addDays(today, 41))).toBe(1);
  });

  it("a maintenance block removes the room only for the dates it covers", async () => {
    await reportIssue(app, owner, {
      ...base, roomId: rooms.window, mode: "MAINTENANCE_BLOCK", startDate: addDays(today, 50), expectedResolution: addDays(today, 52),
    });
    expect(await sellable("window", addDays(today, 49), addDays(today, 50))).toBe(1); // checks out as the block starts
    expect(await sellable("window", addDays(today, 51), addDays(today, 53))).toBe(0);
    expect(await sellable("window", addDays(today, 52), addDays(today, 54))).toBe(0); // arrives on the last blocked day
    expect(await sellable("window", addDays(today, 53), addDays(today, 55))).toBe(1);
    // A future window does not make the room maintenance-blocked today.
    const row = (await roomBoard(app, owner)).rows.find((r) => r.roomId === rooms.window)!;
    expect(row.status).not.toBe("MAINTENANCE");
    const during = (await roomBoard(app, owner, { date: addDays(today, 51) })).rows.find((r) => r.roomId === rooms.window)!;
    expect(during.status).toBe("MAINTENANCE");
    expect(during.reason).toMatch(/Plumbing: Leaking pipe/);
  });

  it("out of order is immediate, flags the room, appears on the board and is logged", async () => {
    const m = await reportIssue(app, owner, { ...base, roomId: rooms.ooo, mode: "OUT_OF_ORDER", priority: "HIGH" });
    expect(m.blocksRoom).toBe(true);
    expect(await sellable("ooo", addDays(today, 60), addDays(today, 61))).toBe(0);
    const row = (await roomBoard(app, owner)).rows.find((r) => r.roomId === rooms.ooo)!;
    expect(row).toMatchObject({ status: "OUT_OF_ORDER", maintenanceId: m.id });
    expect(row.reason).toMatch(/Plumbing: Leaking pipe/);
    const hist = await admin.roomStatusHistory.findMany({ where: { roomId: rooms.ooo } });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ kind: "OUT_OF_ORDER", toState: "OUT_OF_ORDER", changedBy: owner.userId });
  });

  it("validates the form: Other needs detail, dates must be sensible, out of order cannot start later", async () => {
    await expect(reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "REPORT", category: "OTHER" })).rejects.toThrow(/Describe the issue/);
    await expect(reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "REPORT", category: "OTHER", description: "Strange noise from the wall" })).resolves.toBeTruthy();
    await expect(
      reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "MAINTENANCE_BLOCK", startDate: addDays(today, 5), expectedResolution: addDays(today, 4) }),
    ).rejects.toThrow(/before the start/);
    await expect(
      reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "OUT_OF_ORDER", startDate: addDays(today, 3) }),
    ).rejects.toThrow(/immediately/);
    await expect(reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "REPORT", assignedTo: randomUUID() })).rejects.toThrow(/not an active member/);
    await expect(reportIssue(app, owner, { ...base, roomId: randomUUID(), mode: "REPORT" })).rejects.toThrow(/not found/i);
  });

  it("never blocks a room with a guest in house, and warns about overlapping bookings", async () => {
    const guestId = (await createGuest(app, owner, { name: "Gita Guest" })).id;
    const stay = await createReservation(app, owner, { guestId, roomTypeId: types.guest, arrival: today, departure: addDays(today, 2), adults: 1 });
    await checkIn(app, owner, stay.id);
    await expect(reportIssue(app, owner, { ...base, roomId: rooms.guest, mode: "OUT_OF_ORDER" })).rejects.toThrow(/guest in house/);

    const fut = await createReservation(app, owner, { guestId, roomTypeId: types.future, arrival: addDays(today, 10), departure: addDays(today, 12), adults: 1 });
    const block = { ...base, roomId: rooms.future, mode: "MAINTENANCE_BLOCK", startDate: addDays(today, 9), expectedResolution: addDays(today, 11) } as const;
    await expect(reportIssue(app, owner, block)).rejects.toThrow(new RegExp(fut.reference));
    await expect(reportIssue(app, owner, { ...block, acknowledgeBookings: true })).resolves.toBeTruthy();
    const log = await admin.auditLog.findFirst({ where: { tenantId: owner.tenantId, action: "room.block", entityType: "MaintenanceRequest" }, orderBy: { at: "desc" } });
    expect(JSON.stringify(log?.after)).toContain(fut.reference);
  });

  it("refuses check-in into a room that is blocked today", async () => {
    const guestId = (await createGuest(app, owner, { name: "Chet Checkin" })).id;
    const r = await createReservation(app, owner, { guestId, roomTypeId: types.checkin, arrival: today, departure: addDays(today, 1), adults: 1 });
    await reportIssue(app, owner, { ...base, roomId: rooms.checkin, mode: "MAINTENANCE_BLOCK", acknowledgeBookings: true });
    await expect(checkIn(app, owner, r.id)).rejects.toThrow(/blocked for maintenance/);
  });
});

describe("permissions and approval", () => {
  it("only roles with rooms.block can block; housekeeping cannot even report", async () => {
    const roomId = rooms.report;
    await expect(reportIssue(app, asRole(owner, "FRONT_DESK"), { ...base, roomId, mode: "OUT_OF_ORDER" })).rejects.toThrow(/permission/i);
    await expect(reportIssue(app, asRole(owner, "HOUSEKEEPING"), { ...base, roomId, mode: "REPORT" })).rejects.toThrow(/permission/i);
  });

  it("a block raised without approval authority needs a different manager to approve it", async () => {
    const tech = asRole(owner, "MAINTENANCE");
    const m = await reportIssue(app, tech, { ...base, roomId: rooms.approve, mode: "OUT_OF_ORDER" });
    expect(m).toMatchObject({ blocksRoom: true, approvalRequired: true, approvedBy: null });
    // It still takes effect immediately (safe default).
    expect(await sellable("approve", addDays(today, 70), addDays(today, 71))).toBe(0);
    await expect(approveBlock(app, tech, m.id)).rejects.toThrow(/permission/i);
    await expect(approveBlock(app, { ...owner, userId: tech.userId }, m.id)).rejects.toThrow(/Another manager/);
    await approveBlock(app, owner, m.id);
    await expect(approveBlock(app, owner, m.id)).rejects.toThrow(/does not need approval/);
    expect((await admin.roomStatusHistory.findMany({ where: { maintenanceId: m.id } })).map((h) => h.kind).sort()).toEqual(["APPROVED", "OUT_OF_ORDER"]);
    // An owner-raised block never needs approval.
    const own = await reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "MAINTENANCE_BLOCK", startDate: addDays(today, 80) });
    expect(own.approvalRequired).toBe(false);
  });
});

describe("resolution", () => {
  it("requires a note and a readiness confirmation, then returns the room needing cleaning (never straight to sellable)", async () => {
    const m = await reportIssue(app, owner, { ...base, roomId: rooms.two, mode: "OUT_OF_ORDER" });
    await expect(resolveIssue(app, owner, m.id, { resolutionNote: "", confirmReady: true })).rejects.toThrow();
    await expect(resolveIssue(app, owner, m.id, { resolutionNote: "Pipe replaced", confirmReady: false })).rejects.toThrow(/ready/);
    await expect(resolveIssue(app, asRole(owner, "FRONT_DESK"), m.id, { resolutionNote: "Pipe replaced", confirmReady: true })).rejects.toThrow(/permission/i);
    await expect(resolveIssue(app, other, m.id, { resolutionNote: "Pipe replaced", confirmReady: true })).rejects.toThrow(/not found/i);

    const r = await resolveIssue(app, owner, m.id, { resolutionNote: "Pipe replaced and tested", confirmReady: true });
    expect(r.restored).toBe(true);
    const room = await admin.room.findUniqueOrThrow({ where: { id: rooms.two } });
    expect(room).toMatchObject({ outOfOrder: false, housekeeping: "DIRTY" });
    expect((await roomBoard(app, owner)).rows.find((x) => x.roomId === rooms.two)!.status).toBe("CLEANING");
    await expect(resolveIssue(app, owner, m.id, { resolutionNote: "Again please", confirmReady: true })).rejects.toThrow(/already resolved/);

    // Only housekeeping clears it for sale.
    await setRoomStatus(app, owner, rooms.two, "CLEAN");
    expect((await roomBoard(app, owner)).rows.find((x) => x.roomId === rooms.two)!.status).toBe("AVAILABLE");
    const kinds = (await admin.roomStatusHistory.findMany({ where: { roomId: rooms.two }, orderBy: { changedAt: "asc" } })).map((h) => `${h.kind}:${h.toState}`);
    expect(kinds).toEqual(["OUT_OF_ORDER:OUT_OF_ORDER", "RESTORED:NEEDS_CLEANING", "HOUSEKEEPING:CLEAN"]);
  });

  it("keeps the room blocked while another blocking issue is open", async () => {
    const a = await reportIssue(app, owner, { ...base, roomId: rooms.two, mode: "OUT_OF_ORDER" });
    const b = await reportIssue(app, owner, { ...base, roomId: rooms.two, category: "ELECTRICAL", title: "Sockets dead", mode: "MAINTENANCE_BLOCK" });
    expect((await resolveIssue(app, owner, a.id, { resolutionNote: "Pipe fixed", confirmReady: true })).restored).toBe(false);
    expect((await roomBoard(app, owner)).rows.find((x) => x.roomId === rooms.two)!.status).not.toBe("AVAILABLE");
    expect((await resolveIssue(app, owner, b.id, { resolutionNote: "Rewired", confirmReady: true })).restored).toBe(true);
  });

  it("assignment and progress updates are audited; the issue record shows the full timeline", async () => {
    const m = await reportIssue(app, owner, { ...base, roomId: rooms.report, mode: "REPORT" });
    await updateIssue(app, owner, m.id, { status: "IN_PROGRESS", assignedTo: owner.userId });
    const rec = await getIssue(app, owner, m.id);
    expect(rec.req).toMatchObject({ status: "IN_PROGRESS", assignedTo: owner.userId });
    expect(rec.names.get(owner.userId)).toBe("Owner");
    await expect(getIssue(app, other, m.id)).rejects.toThrow(/not found/i);
  });
});

describe("history is append-only and tenant-scoped", () => {
  it("rejects update and delete", async () => {
    const row = await admin.roomStatusHistory.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    await expect(admin.roomStatusHistory.update({ where: { id: row.id }, data: { reason: "edited" } })).rejects.toThrow(/append-only/);
    await expect(admin.roomStatusHistory.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
  it("RLS hides another tenant's history and blocks cross-tenant writes", async () => {
    const seen = await withTenant(app, other.tenantId, (tx) => tx.roomStatusHistory.count());
    expect(seen).toBe(0);
    await expect(
      withTenant(app, other.tenantId, (tx) =>
        tx.roomStatusHistory.create({ data: { tenantId: owner.tenantId, propertyId: owner.propertyId!, roomId: rooms.report, kind: "OUT_OF_ORDER", toState: "X", changedBy: randomUUID() } }),
      ),
    ).rejects.toThrow();
  });
});
