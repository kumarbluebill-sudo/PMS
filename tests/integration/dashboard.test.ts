import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType, setRoomFloor } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { checkIn, checkOut, createReservation } from "@/server/services/reservations";
import { createMaintenanceRequest } from "@/server/services/housekeeping";
import { openFolio, postCharge } from "@/server/services/billing";
import { roomBoard } from "@/server/services/dashboard";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
const ids: Record<string, string> = {};
const rooms: Record<string, string> = {};

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function tenant(label: string) {
  const r = await registerTenant(app, {
    businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner",
    email: `dash-${label}-${sfx}@test.local`, password: "correct-horse-battery",
  });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  const today = (await roomBoard(app, owner)).today;
  const guest = async (name: string) => (await createGuest(app, owner, { name })).id;

  // One room per type so each scenario lands in a known room.
  const spec: [string, number, number][] = [
    ["occupied", 101, 1], ["dueout", 102, 1], ["reserved", 103, 2], ["ooo", 104, 2],
    ["maint", 105, 3], ["cleaning", 106, 3], ["free", 107, 3],
  ];
  for (const [key, number, floor] of spec) {
    const rt = await createRoomType(app, owner, { name: `T-${key}`, maxAdults: 2, baseRateMinor: 100_000 + number * 100 });
    ids[key] = rt.id;
    const room = await createRoom(app, owner, { roomTypeId: rt.id, number: String(number), floor });
    rooms[key] = room.id;
  }
  const book = async (key: string, name: string, from: string, to: string) =>
    createReservation(app, owner, { guestId: await guest(name), roomTypeId: ids[key], arrival: from, departure: to, adults: 1 });

  const occ = await book("occupied", "Olivia Occupied", today, addDays(today, 2));
  await checkIn(app, owner, occ.id);
  const due = await book("dueout", "Dev Dueout", addDays(today, -1), today);
  await checkIn(app, owner, due.id);
  await book("reserved", "Rita Reserved", addDays(today, 5), addDays(today, 7));
  const gone = await book("cleaning", "Carl Checkedout", addDays(today, -1), today);
  await checkIn(app, owner, gone.id);
  await checkOut(app, owner, gone.id, { waiveReason: "test fixture" });

  await admin.room.update({ where: { id: rooms.ooo }, data: { outOfOrder: true } });
  await createMaintenanceRequest(app, owner, { roomId: rooms.ooo, title: "AC compressor failed", blocksRoom: true });
  await createMaintenanceRequest(app, owner, { roomId: rooms.maint, title: "Repaint walls", blocksRoom: true });

  const folio = await openFolio(app, owner, occ.id);
  await postCharge(app, owner, folio.id, { category: "FNB", description: "Dinner", amountMinor: 250_000, idempotencyKey: `dash-${sfx}-1` });
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

const byNumber = (rows: Awaited<ReturnType<typeof roomBoard>>["rows"]) => Object.fromEntries(rows.map((r) => [r.number, r]));

describe("room board", () => {
  it("lists every configured room, including rooms with no reservation", async () => {
    const b = await roomBoard(app, owner);
    expect(b.rows.map((r) => r.number)).toEqual(["101", "102", "103", "104", "105", "106", "107"]);
    expect(b.cards.totalRooms).toBe(7);
    expect(byNumber(b.rows)["107"].stay).toBeNull();
  });

  it("derives each status from real data", async () => {
    const r = byNumber((await roomBoard(app, owner)).rows);
    expect(r["101"].status).toBe("OCCUPIED");
    expect(r["102"].status).toBe("DUE_OUT");
    expect(r["103"].status).toBe("RESERVED");
    expect(r["104"].status).toBe("OUT_OF_ORDER");
    expect(r["105"].status).toBe("MAINTENANCE");
    expect(r["106"].status).toBe("CLEANING");
    expect(r["107"].status).toBe("AVAILABLE");
  });

  it("shows the right guest, booking reference and dates on the right room", async () => {
    const r = byNumber((await roomBoard(app, owner)).rows);
    expect(r["101"].stay).toMatchObject({ guest: "Olivia Occupied", kind: "CURRENT", reservationStatus: "CHECKED_IN" });
    expect(r["101"].stay!.reference).toMatch(/^MK-/);
    expect(r["102"].stay).toMatchObject({ guest: "Dev Dueout", kind: "CURRENT" });
    expect(r["103"].stay).toMatchObject({ guest: "Rita Reserved", kind: "UPCOMING", reservationStatus: "CONFIRMED" });
    expect(r["106"].stay).toMatchObject({ guest: "Carl Checkedout", kind: "LAST" });
    expect(r["106"].stay!.actualCheckout).toBeTruthy();
  });

  it("shows out-of-order and maintenance reasons", async () => {
    const r = byNumber((await roomBoard(app, owner)).rows);
    expect(r["104"].reason).toBe("AC compressor failed");
    expect(r["105"].reason).toBe("Repaint walls");
    expect(r["104"].maintenanceId).toBeTruthy();
  });

  it("cards reconcile with the room statuses", async () => {
    const { cards, rows } = await roomBoard(app, owner);
    expect(cards).toMatchObject({
      totalRooms: 7, available: 2, availableReserved: 1, occupied: 2, checkoutsToday: 1,
      checkedOutToday: 1, outOfOrder: 1, maintenance: 1, cleaning: 1, arrivalsToday: 0,
    });
    expect(cards.available + cards.occupied + cards.outOfOrder + cards.maintenance + cards.cleaning).toBe(rows.length);
  });

  it("expected revenue is today's room nights at base rate and pending payments are posted folio balances", async () => {
    const { cards } = await roomBoard(app, owner);
    expect(cards.expectedRevenueMinor).toBe(100_000 + 101 * 100); // only the occupied room is staying tonight
    expect(cards.pendingPaymentsMinor).toBe(250_000);
    const r = byNumber((await roomBoard(app, owner)).rows);
    expect(r["101"]).toMatchObject({ balanceMinor: 250_000, paymentStatus: "UNPAID" });
  });

  it("filters by status, floor, room type and search; sorts", async () => {
    expect((await roomBoard(app, owner, { status: "OCCUPIED" })).rows.map((r) => r.number)).toEqual(["101"]);
    const floor3 = await roomBoard(app, owner, { floor: 3 });
    expect(floor3.rows.map((r) => r.number)).toEqual(["105", "106", "107"]);
    expect(floor3.cards.totalRooms).toBe(3);
    expect((await roomBoard(app, owner, { roomTypeId: ids.dueout })).rows.map((r) => r.number)).toEqual(["102"]);
    expect((await roomBoard(app, owner, { q: "rita" })).rows.map((r) => r.number)).toEqual(["103"]);
    expect((await roomBoard(app, owner, { sort: "status" })).rows[0].status).toBe("AVAILABLE");
    expect((await roomBoard(app, owner, { sort: "checkout" })).rows[0].stay?.departure).toBeTruthy();
    const b = await roomBoard(app, owner);
    expect((await roomBoard(app, owner, { checkout: b.today })).rows.map((r) => r.number)).toEqual(["102", "106"]);
  });

  it("projects a future date without applying today's housekeeping state", async () => {
    const today = (await roomBoard(app, owner)).today;
    const future = await roomBoard(app, owner, { date: addDays(today, 1) });
    expect(future.live).toBe(false);
    const r = byNumber(future.rows);
    expect(r["101"].status).toBe("OCCUPIED"); // stays until today+2
    expect(r["102"].status).toBe("AVAILABLE"); // left today
    expect(r["106"].status).toBe("AVAILABLE"); // dirty now, but housekeeping is not projected
    expect(r["104"].status).toBe("OUT_OF_ORDER"); // still blocked
  });

  it("an out-of-order or maintenance-blocked room can never be sold", async () => {
    const guestId = (await createGuest(app, owner, { name: "Sale Attempt" })).id;
    const day = addDays((await roomBoard(app, owner)).today, 20);
    for (const key of ["ooo", "maint"]) {
      await expect(
        createReservation(app, owner, { guestId, roomTypeId: ids[key], arrival: day, departure: addDays(day, 1), adults: 1 }),
      ).rejects.toThrow(/No room of this type is available/);
    }
  });

  it("redacts guest and money fields for roles without access", async () => {
    const hk: Ctx = { ...owner, role: "HOUSEKEEPING", extra: [] };
    const b = await roomBoard(app, hk);
    const r = byNumber(b.rows);
    expect(r["101"].status).toBe("OCCUPIED");
    expect(r["101"].stay?.guest).toBeNull();
    expect(r["101"].balanceMinor).toBeNull();
    expect(b.cards.pendingPaymentsMinor).toBeNull();
  });

  it("is isolated per tenant and floors are editable", async () => {
    expect((await roomBoard(app, other)).rows).toHaveLength(0);
    await setRoomFloor(app, owner, rooms.free, 9);
    expect((await roomBoard(app, owner, { floor: 9 })).rows.map((r) => r.number)).toEqual(["107"]);
    await expect(setRoomFloor(app, other, rooms.free, 1)).rejects.toThrow(/not found/i);
  });
});
