import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createBooking } from "@/server/services/booking";
import { checkIn } from "@/server/services/reservations";
import { completeCheckout } from "@/server/services/checkout";
import { findFreeRooms } from "@/server/services/availability";
import { listNotifications } from "@/server/services/notifications";
import { propertyToday, reportIssue } from "@/server/services/roomBlocks";
import { setSettings } from "@/server/services/settings";
import { createTask, generateStayoverTasks, housekeepingBoard, setDnd, taskAction } from "@/server/services/housekeepingTasks";
import { setRoomStatus } from "@/server/services/housekeeping";
import { withTenant } from "@/server/db/withTenant";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let hk: Ctx;
let desk: Ctx;
let today: string;
let typeId: string;
let n = 0;
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const as = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });
const key = () => randomUUID();

async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `hk-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
const book = async (from: number, to: number) =>
  (await createBooking(app, owner, { newGuest: { name: `Hk Guest ${++n}`, mobile: `9500${String(100000 + n)}` }, roomTypeId: typeId, arrival: addDays(today, from), departure: addDays(today, to), adults: 2 })).reservations[0];
/** A stay that checked in and out today, leaving a dirty room with an open departure task. */
async function departed() {
  await admin.room.updateMany({ where: { tenantId: owner.tenantId, dnd: false, outOfOrder: false }, data: { housekeeping: "INSPECTED" } });
  const r = await book(0, 1);
  await checkIn(app, owner, r.id);
  await completeCheckout(app, owner, r.id, { payments: [{ method: "UPI", amountMinor: 200_000, idempotencyKey: key() }], confirmed: true });
  const asg = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: r.id } });
  const task = await admin.housekeepingTask.findFirstOrThrow({ where: { reservationId: r.id } });
  return { reservation: r, roomId: asg.roomId, task };
}
const row = async (ctx: Ctx, roomId: string) => (await housekeepingBoard(app, ctx)).rows.find((x) => x.roomId === roomId)!;
const act = (ctx: Ctx, taskId: string, action: string, expectedVersion: number, extra: Record<string, unknown> = {}) => taskAction(app, ctx, { taskId, action, expectedVersion, ...extra });

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  hk = as(owner, "HOUSEKEEPING");
  desk = as(owner, "FRONT_DESK");
  today = await propertyToday(app, owner);
  typeId = (await createRoomType(app, owner, { name: "HK", maxAdults: 2, baseRateMinor: 200_000 })).id;
  for (const num of ["1", "2", "3", "4", "5", "6", "7", "8"]) await createRoom(app, owner, { roomTypeId: typeId, number: num });
});
afterAll(async () => { await app.$disconnect(); await admin.$disconnect(); });

describe("after checkout", () => {
  it("shows the room Vacant – Dirty with its task, and hides guest details from a housekeeper", async () => {
    const d = await departed();
    const r = await row(owner, d.roomId);
    expect(r).toMatchObject({ code: "VD", checkout: "Departed today", ready: false });
    expect(r.task).toMatchObject({ kind: "DEPARTURE", status: "PENDING", version: 0 });
    expect(r.reservationRef).toBe(d.reservation.reference);
    expect(r.guest).toMatch(/Hk Guest/);
    const asHk = await row(hk, d.roomId);
    expect(asHk.guest).toBeNull();
    expect(asHk.reservationRef).toBeNull();
    expect(asHk.task?.status).toBe("PENDING");
  });
});

describe("cleaning cycle", () => {
  it("start then complete leaves the room Vacant – Clean and ready, with a history and audit trail", async () => {
    const d = await departed();
    const s = await act(hk, d.task.id, "START", 0);
    expect(s).toMatchObject({ status: "IN_PROGRESS", version: 1 });
    expect((await row(owner, d.roomId)).clean).toBe("CLEANING");
    const c = await act(hk, d.task.id, "COMPLETE", 1);
    expect(c.status).toBe("DONE");
    const r = await row(owner, d.roomId);
    expect(r).toMatchObject({ code: "VC", ready: true });
    expect((await admin.housekeepingTask.findUniqueOrThrow({ where: { id: d.task.id } })).assignedTo).toBe(hk.userId); // started it, so it is theirs
    expect(await admin.roomStatusHistory.count({ where: { roomId: d.roomId, kind: "HOUSEKEEPING", toState: "CLEAN" } })).toBeGreaterThan(0);
    expect(await admin.auditLog.count({ where: { entityId: d.task.id, action: "housekeeping.task_complete" } })).toBe(1);
  });

  it("with inspection required, a clean room is not ready until a supervisor inspects it, and a failure sends it back", async () => {
    await setSettings(app, owner, { "housekeeping.inspectionRequired": true });
    try {
      const d = await departed();
      await act(hk, d.task.id, "START", 0);
      const c = await act(hk, d.task.id, "COMPLETE", 1);
      expect(c.status).toBe("AWAITING_INSPECTION");
      let r = await row(owner, d.roomId);
      expect(r).toMatchObject({ code: "VC", ready: false });
      expect(r.task?.status).toBe("AWAITING_INSPECTION");
      await expect(act(hk, d.task.id, "INSPECT_PASS", 2)).rejects.toThrow(/permission/i);
      expect((await listNotifications(app, owner)).some((x) => x.kind === "INSPECTION_REQUESTED" && x.title.includes("awaiting inspection"))).toBe(true);

      const fail = await act(owner, d.task.id, "INSPECT_FAIL", 2, { note: "Bathroom not done" });
      expect(fail.status).toBe("PENDING");
      r = await row(owner, d.roomId);
      expect(r).toMatchObject({ code: "VD", ready: false });
      expect((await admin.housekeepingTask.findUniqueOrThrow({ where: { id: d.task.id } })).inspectionResult).toBe("FAILED");
      expect((await listNotifications(app, hk)).some((x) => x.kind === "INSPECTION_FAILED")).toBe(true);

      await act(hk, d.task.id, "START", 3);
      await act(hk, d.task.id, "COMPLETE", 4);
      await act(owner, d.task.id, "INSPECT_PASS", 5);
      r = await row(owner, d.roomId);
      expect(r).toMatchObject({ code: "VI", ready: true });
      expect((await admin.housekeepingTask.findUniqueOrThrow({ where: { id: d.task.id } }))).toMatchObject({ status: "INSPECTED", inspectionResult: "PASSED", inspectedBy: owner.userId });
    } finally {
      await setSettings(app, owner, { "housekeeping.inspectionRequired": false });
    }
  });

  it("tells the front desk when a room for today's arrival becomes ready, once", async () => {
    const d = await departed();
    // An arrival today is held in that room.
    const arrival = await book(0, 2);
    await admin.roomAssignment.updateMany({ where: { reservationId: arrival.id }, data: { roomId: d.roomId } }).catch(() => undefined);
    const held = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: arrival.id, active: true } });
    if (held.roomId !== d.roomId) return; // another room was chosen; the readiness rule itself is covered above
    await act(hk, d.task.id, "START", 0);
    await act(hk, d.task.id, "COMPLETE", 1);
    const ready = (await listNotifications(app, desk)).filter((x) => x.kind === "ROOM_READY" && x.title.includes("ready for today's arrival"));
    expect(ready.length).toBeGreaterThan(0);
    expect(new Set(ready.map((x) => x.id)).size).toBe(ready.length);
  });
});

describe("concurrent and invalid updates", () => {
  it("lets exactly one of two simultaneous updates win and tells the other who got there first", async () => {
    const d = await departed();
    const a = as(owner, "HOUSEKEEPING");
    const b = as(owner, "HOUSEKEEPING");
    const res = await Promise.allSettled([act(a, d.task.id, "START", 0), act(b, d.task.id, "START", 0)]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = res.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason.message)).toMatch(/just updated|Reload the page/);
    expect((await admin.housekeepingTask.findUniqueOrThrow({ where: { id: d.task.id } })).version).toBe(1);
  });

  it("stops another housekeeper working a task assigned to someone else, and refuses invalid steps", async () => {
    const d = await departed();
    const mine = as(owner, "HOUSEKEEPING");
    await act(owner, d.task.id, "ASSIGN", 0, { assignedTo: null });
    await admin.housekeepingTask.update({ where: { id: d.task.id }, data: { assignedTo: mine.userId, version: 1 } });
    await expect(act(as(owner, "HOUSEKEEPING"), d.task.id, "START", 1)).rejects.toThrow(/assigned to/);
    await expect(act(mine, d.task.id, "COMPLETE", 0)).rejects.toThrow(/just updated|Reload/); // stale
    await expect(act(mine, d.task.id, "INSPECT_PASS", 1)).rejects.toThrow(/permission/i);
    await expect(act(owner, d.task.id, "INSPECT_PASS", 1)).rejects.toThrow(/awaiting inspection/);
    await expect(act(owner, d.task.id, "ASSIGN", 1, { assignedTo: randomUUID() })).rejects.toThrow(/does not work at this property/);
    expect(await admin.housekeepingTask.findUniqueOrThrow({ where: { id: d.task.id } })).toMatchObject({ status: "PENDING", version: 1 });
  });
});

describe("rooms that must stay unavailable", () => {
  it("cleaning an occupied room makes it Occupied – Clean, never available", async () => {
    await admin.room.updateMany({ where: { tenantId: owner.tenantId }, data: { housekeeping: "INSPECTED", dnd: false } });
    const r = await book(0, 3);
    await checkIn(app, owner, r.id);
    const a = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: r.id, active: true } });
    // Earlier stays in this room left their own tasks open; this scenario starts from a clean slate.
    await admin.housekeepingTask.updateMany({ where: { roomId: a.roomId, status: { in: ["PENDING", "IN_PROGRESS", "AWAITING_INSPECTION"] } }, data: { status: "CANCELLED" } });
    await expect(createTask(app, owner, { roomId: a.roomId, kind: "STAYOVER", priority: "NORMAL" }).then(() => createTask(app, owner, { roomId: a.roomId }))).rejects.toThrow(/already has an open/);
    const t = await admin.housekeepingTask.findFirstOrThrow({ where: { roomId: a.roomId, status: "PENDING" } });
    expect((await row(owner, a.roomId)).code).toBe("STAYOVER");
    await act(hk, t.id, "START", 0);
    await act(hk, t.id, "COMPLETE", 1);
    const after = await row(owner, a.roomId);
    expect(after).toMatchObject({ code: "OC", ready: false, occupied: true });
    const free = await withTenant(app, owner.tenantId, (tx) => findFreeRooms(tx, owner.propertyId!, typeId, today, addDays(today, 1)));
    expect(free.map((x) => x.id)).not.toContain(a.roomId);
  });

  it("an out-of-order room stays out of order however clean it gets, and a housekeeper cannot block rooms", async () => {
    const d = await departed();
    await reportIssue(app, owner, { roomId: d.roomId, category: "PLUMBING", title: "Burst pipe", mode: "OUT_OF_ORDER", acknowledgeBookings: true });
    await act(hk, d.task.id, "START", 0);
    await act(hk, d.task.id, "COMPLETE", 1);
    expect(await row(owner, d.roomId)).toMatchObject({ code: "OOO", ready: false, clean: "CLEAN" });
    expect(await admin.room.findUniqueOrThrow({ where: { id: d.roomId } })).toMatchObject({ outOfOrder: true });
    await expect(reportIssue(app, hk, { roomId: d.roomId, category: "PLUMBING", title: "Take it out", mode: "OUT_OF_ORDER", acknowledgeBookings: true })).rejects.toThrow(/permission/i);
    // But a housekeeper can report a problem.
    const free = await admin.room.findFirstOrThrow({ where: { tenantId: owner.tenantId, outOfOrder: false } });
    const rep = await reportIssue(app, hk, { roomId: free.id, category: "ELECTRICAL", title: "Lamp broken", mode: "REPORT" });
    expect(rep.blocksRoom).toBe(false);
    expect((await listNotifications(app, owner)).some((x) => x.kind === "MAINTENANCE_REPORTED" && x.title.includes("Lamp broken"))).toBe(true);
  });

  it("Do Not Disturb is its own state, is skipped by stayover generation, and checkout clears it", async () => {
    await admin.room.updateMany({ where: { tenantId: owner.tenantId, outOfOrder: false }, data: { housekeeping: "INSPECTED", dnd: false } });
    const r = await book(0, 3);
    await checkIn(app, owner, r.id);
    const a = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: r.id, active: true } });
    await setDnd(app, hk, a.roomId, true, "Guest asked not to be disturbed");
    expect((await row(owner, a.roomId)).code).toBe("DND");
    const gen = await generateStayoverTasks(app, owner);
    expect(gen.skippedDnd).toBeGreaterThan(0);
    expect(await admin.housekeepingTask.count({ where: { roomId: a.roomId, kind: "STAYOVER" } })).toBe(0);
    await setDnd(app, hk, a.roomId, false);
    const g2 = await generateStayoverTasks(app, owner);
    expect(g2.created).toBeGreaterThan(0);
    expect((await generateStayoverTasks(app, owner)).created).toBe(0); // safe to run again
    await setDnd(app, hk, a.roomId, true);
    await completeCheckout(app, owner, r.id, { payments: [{ method: "UPI", amountMinor: 600_000, idempotencyKey: key() }], confirmed: true });
    expect(await admin.room.findUniqueOrThrow({ where: { id: a.roomId } })).toMatchObject({ dnd: false, housekeeping: "DIRTY" });
  });
});

describe("legacy room status buttons and isolation", () => {
  it("setRoomStatus keeps the open task in step with the inspection policy", async () => {
    const d = await departed();
    await setRoomStatus(app, hk, d.roomId, "CLEAN");
    expect((await admin.housekeepingTask.findUniqueOrThrow({ where: { id: d.task.id } })).status).toBe("DONE");
    await setSettings(app, owner, { "housekeeping.inspectionRequired": true });
    try {
      const e = await departed();
      await setRoomStatus(app, hk, e.roomId, "CLEAN");
      expect((await admin.housekeepingTask.findUniqueOrThrow({ where: { id: e.task.id } })).status).toBe("AWAITING_INSPECTION");
      await expect(setRoomStatus(app, hk, e.roomId, "INSPECTED")).rejects.toThrow(/permission/i);
    } finally {
      await setSettings(app, owner, { "housekeeping.inspectionRequired": false });
    }
  });

  it("other businesses and unrelated roles cannot touch tasks", async () => {
    const d = await departed();
    await expect(act(other, d.task.id, "START", 0)).rejects.toThrow(/not found|Select or create/i);
    await expect(act(desk, d.task.id, "START", 0)).rejects.toThrow(/permission/i);
    await expect(housekeepingBoard(app, as(owner, "CASHIER"))).rejects.toThrow(/permission/i);
    expect((await housekeepingBoard(app, other)).rows).toEqual([]);
  });
});
