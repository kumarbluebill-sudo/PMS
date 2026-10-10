import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant, verifyCredentials } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest, searchGuests } from "@/server/services/guests";
import {
  cancelReservation, checkIn, checkOut, createReservation, listReservations,
} from "@/server/services/reservations";
import { setRoomStatus } from "@/server/services/housekeeping";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
let app: PrismaClient;
let ownerA: Ctx;
let ownerB: Ctx;
let roomTypeId: string;
let guestId: string;
const sfx = Date.now().toString(36);

async function setup(label: string) {
  const r = await registerTenant(app, {
    businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner",
    email: `owner-${label}-${sfx}@test.local`, password: "correct-horse-battery",
  });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}

beforeAll(async () => {
  app = createDb(APP_URL);
  ownerA = await setup("a");
  ownerB = await setup("b");
  const rt = await createRoomType(app, ownerA, { name: "Deluxe", maxAdults: 2 });
  roomTypeId = rt.id;
  await createRoom(app, ownerA, { roomTypeId, number: "101" });
  await createRoom(app, ownerA, { roomTypeId, number: "102" });
  guestId = (await createGuest(app, ownerA, { name: "Asha Test" })).id;
});
afterAll(() => app.$disconnect());

const stay = { arrival: "2031-01-10", departure: "2031-01-12" };

describe("auth", () => {
  it("verifies credentials and rejects bad ones", async () => {
    expect(await verifyCredentials(app, `owner-a-${sfx}@test.local`, "correct-horse-battery")).toBeTruthy();
    expect(await verifyCredentials(app, `owner-a-${sfx}@test.local`, "wrong")).toBeNull();
    expect(await verifyCredentials(app, "nobody@test.local", "x")).toBeNull();
  });
  it("rejects a revoked session epoch", async () => {
    await expect(loadContext(app, { userId: ownerA.userId, epoch: 99 })).rejects.toThrow();
  });
});

describe("reservation workflow", () => {
  it("rejects concurrent overbooking: 2 rooms, 6 requests -> 2 succeed", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createReservation(app, ownerA, { guestId, roomTypeId, ...stay, adults: 2 }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(2);
    const rooms = new Set(ok.map((r) => (r as PromiseFulfilledResult<{ roomId: string }>).value.roomId));
    expect(rooms.size).toBe(2);
  });

  it("runs check-in, check-out, and leaves the room dirty with a task", async () => {
    const [res] = await listReservations(app, ownerA, { status: "CONFIRMED" });
    await checkIn(app, ownerA, res.id);
    await expect(checkIn(app, ownerA, res.id)).rejects.toThrow(); // illegal transition
    await checkOut(app, ownerA, res.id);
    const roomId = res.assignments[0]?.roomId ?? (await withTenant(app, ownerA.tenantId, (tx) =>
      tx.roomAssignment.findFirst({ where: { reservationId: res.id } })))!.roomId;
    const room = await withTenant(app, ownerA.tenantId, (tx) => tx.room.findUnique({ where: { id: roomId } }));
    expect(room?.housekeeping).toBe("DIRTY");
    const tasks = await withTenant(app, ownerA.tenantId, (tx) => tx.housekeepingTask.findMany({ where: { roomId } }));
    expect(tasks).toHaveLength(1);
  });

  it("frees the room on cancellation so it can be rebooked", async () => {
    const [res] = await listReservations(app, ownerA, { status: "CONFIRMED" });
    await expect(cancelReservation(app, ownerA, res.id, " ")).rejects.toThrow();
    await cancelReservation(app, ownerA, res.id, "Guest request");
    await expect(createReservation(app, ownerA, { guestId, roomTypeId, ...stay })).resolves.toBeTruthy();
  });

  it("records audit entries for the workflow", async () => {
    const logs = await app.auditLog.findMany({ where: { tenantId: ownerA.tenantId } });
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ["reservation.create", "reservation.checked_in", "reservation.checked_out", "reservation.cancelled"]) {
      expect(actions.has(a)).toBe(true);
    }
  });
});

describe("tenant isolation through services", () => {
  it("tenant B sees none of tenant A's data", async () => {
    await createRoomType(app, ownerB, { name: "Std" });
    expect(await listReservations(app, ownerB)).toHaveLength(0);
    expect(await searchGuests(app, ownerB)).toHaveLength(0);
  });
  it("tenant B cannot act on tenant A's reservation or guest", async () => {
    const [res] = await listReservations(app, ownerA);
    await expect(cancelReservation(app, ownerB, res.id, "hack")).rejects.toThrow(/not found/i);
    await expect(createReservation(app, ownerB, { guestId, roomTypeId, ...stay })).rejects.toThrow();
  });
  it("ignores a forged property id", async () => {
    const ctx = await loadContext(app, { userId: ownerB.userId, epoch: 0 }, ownerA.propertyId);
    expect(ctx.propertyId).toBe(ownerB.propertyId);
  });
});

describe("permissions", () => {
  it("housekeeping role cannot create reservations or inspect rooms", async () => {
    const hk: Ctx = { ...ownerA, role: "HOUSEKEEPING", extra: [] };
    await expect(createReservation(app, hk, { guestId, roomTypeId, ...stay })).rejects.toThrow(/permission/i);
    const rooms = await withTenant(app, ownerA.tenantId, (tx) => tx.room.findMany());
    await expect(setRoomStatus(app, hk, rooms[0].id, "INSPECTED")).rejects.toThrow(/permission/i);
    await expect(setRoomStatus(app, hk, rooms[0].id, "CLEAN")).resolves.toBeUndefined();
  });
});
