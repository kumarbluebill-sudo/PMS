import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { cancelReservation, createReservation, listReservationsPage, reservationTimeline, RESERVATION_PAGE_SIZE } from "@/server/services/reservations";
import { moveRoom, rack } from "@/server/services/stays";
import { propertyToday, reportIssue } from "@/server/services/roomBlocks";

import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let typeId: string;
const roomIds: string[] = [];
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `rl-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
let n = 0;
const book = async (name: string, from: number, to: number, extra: Record<string, unknown> = {}) => {
  const g = await createGuest(app, owner, { name: `${name} ${++n}`, phone: "9876500001" });
  return (await createReservation(app, owner, { guestId: g.id, roomTypeId: typeId, arrival: addDays(today, from), departure: addDays(today, to), adults: 1, ...extra })).id;
};

beforeAll(async () => {
  app = createDb(APP_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = await propertyToday(app, owner);
  typeId = (await createRoomType(app, owner, { name: "RL", maxAdults: 2, baseRateMinor: 200_000 })).id;
  for (const num of ["1", "2", "3"]) roomIds.push((await createRoom(app, owner, { roomTypeId: typeId, number: num })).id);
});
afterAll(async () => { await app.$disconnect(); });

describe("reservation list", () => {
  it("returns money columns, filters and pages", async () => {
    const a = await book("Alpha", 1, 3, { externalRef: "BDC-991" });
    await book("Bravo", 5, 6);
    const all = await listReservationsPage(app, owner);
    expect(all.total).toBe(2);
    const row = all.items.find((i) => i.id === a)!;
    expect(row.nights).toBe(2);
    expect(row.externalRef).toBe("BDC-991");
    expect(row.money?.estimated).toBe(true);
    expect(row.money!.totalMinor).toBeGreaterThan(0);
    expect(row.money!.payment).toBe("UNPAID");
    expect(row.createdBy).toBe("Owner");

    expect((await listReservationsPage(app, owner, { q: "BDC-991" })).items.map((i) => i.id)).toEqual([a]);
    expect((await listReservationsPage(app, owner, { q: "bravo" })).total).toBe(1);
    expect((await listReservationsPage(app, owner, { arrivalFrom: addDays(today, 4), arrivalTo: addDays(today, 6) })).total).toBe(1);
    expect((await listReservationsPage(app, owner, { payment: "PAID" })).total).toBe(0);
    expect((await listReservationsPage(app, owner, { payment: "UNPAID" })).total).toBe(2);
    expect((await listReservationsPage(app, owner, { status: "CANCELLED" })).total).toBe(0);
    const desc = await listReservationsPage(app, owner, { sort: "arrival", dir: "desc" });
    expect(desc.items[0].guest.name).toMatch(/^Bravo/);
    expect(all.pageSize).toBe(RESERVATION_PAGE_SIZE);
  });

  it("hides money without billing access and isolates tenants", async () => {
    const reception: Ctx = { ...owner, role: "HOUSEKEEPING" as Ctx["role"], extra: ["reservations.view"], userId: randomUUID() };
    const r = await listReservationsPage(app, reception);
    expect(r.canMoney).toBe(false);
    expect(r.items.every((i) => i.money === null)).toBe(true);
    expect((await listReservationsPage(app, other)).total).toBe(0);
  });
});

describe("change history", () => {
  it("records room move, cancellation reason and the actor", async () => {
    const id = await book("Charlie", 10, 12);
    await moveRoom(app, owner, id, roomIds[2], "Guest asked for quieter room");
    await cancelReservation(app, owner, id, "Change of plans");
    const t = await reservationTimeline(app, owner, id);
    const text = t.map((x) => `${x.what}|${x.reason ?? ""}|${x.by}`).join("\n");
    expect(text).toMatch(/Room changed\|Guest asked for quieter room\|Owner/);
    expect(text).toMatch(/Status: confirmed → cancelled\|Change of plans/);
    await expect(reservationTimeline(app, other, id)).rejects.toThrow(/not found/i);
  });
});

describe("room rack", () => {
  it("lays out bars, blocks and conflicts, and applies filters", async () => {
    const id = await book("Rack", 2, 5);
    const plain = await rack(app, owner, { start: today, days: 14 });
    const row = plain.rooms.find((r) => r.bars.some((b) => b.reservationId === id))!;
    const room = row.id;
    const number = row.number;
    expect(row.bars).toHaveLength(1);
    expect(row.bars[0]).toMatchObject({ col: 2, span: 3, conflict: false, status: "CONFIRMED" });

    await reportIssue(app, owner, { roomId: room, category: "PLUMBING", title: "Pipe burst", mode: "MAINTENANCE_BLOCK", startDate: addDays(today, 3), expectedResolution: addDays(today, 4), acknowledgeBookings: true });
    const blocked = (await rack(app, owner, { start: today, days: 14 })).rooms.find((r) => r.id === room)!;
    expect(blocked.blocks[0]).toMatchObject({ col: 3, span: 2 });
    expect(blocked.bars[0].conflict).toBe(true);

    expect((await rack(app, owner, { start: today, days: 14, q: "rack" })).rooms.map((r) => r.id)).toEqual([room]);
    expect((await rack(app, owner, { start: today, days: 14, q: number })).rooms.some((r) => r.id === room)).toBe(true);
    const vacant = await rack(app, owner, { start: today, days: 14, show: "vacant" });
    expect(vacant.rooms.some((r) => r.id === room)).toBe(false);
    expect((await rack(app, other, { start: today, days: 14 })).rooms).toHaveLength(0);
  });
});
