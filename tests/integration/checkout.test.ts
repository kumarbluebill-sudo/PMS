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
import { listNotifications, markNotificationsRead, unreadNotificationCount } from "@/server/services/notifications";
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
const key = () => randomUUID();
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const as = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });

async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `co-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
/** An in-house two-night stay at 2,000 a night with no GST, so the bill is ₹4,000.00 (400,000 paise). */
async function stay() {
  await admin.room.updateMany({ where: { tenantId: owner.tenantId, dnd: false }, data: { housekeeping: "CLEAN" } });
  const r = await createBooking(app, owner, { newGuest: { name: `Co Guest ${++n}`, mobile: `9300${String(100000 + n)}` }, roomTypeId: typeId, arrival: today, departure: addDays(today, 2), adults: 2 });
  const res = r.reservations[0];
  await checkIn(app, owner, res.id);
  return res;
}
const status = async (id: string) => (await admin.reservation.findUniqueOrThrow({ where: { id } })).status;
const folioOf = async (id: string) => (await admin.folio.findFirstOrThrow({ where: { reservationId: id, label: "GUEST" } })).id;

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = await propertyToday(app, owner);
  typeId = (await createRoomType(app, owner, { name: "CO", maxAdults: 2, baseRateMinor: 200_000 })).id;
  for (const num of ["1", "2", "3", "4", "5", "6"]) await createRoom(app, owner, { roomTypeId: typeId, number: num });
});
afterAll(async () => { await app.$disconnect(); await admin.$disconnect(); });

describe("complete checkout", () => {
  it("takes split payments, issues the invoice and checks out in one go, recording the departure", async () => {
    const res = await stay();
    const before = Date.now();
    const out = await completeCheckout(app, owner, res.id, {
      payments: [{ method: "UPI", amountMinor: 300_000, reference: "UTR1", idempotencyKey: key() }, { method: "CARD", amountMinor: 100_000, idempotencyKey: key() }],
      confirmed: true,
    });
    expect(out).toMatchObject({ balanceMinor: 0, alreadyCheckedOut: false });
    expect(out.paymentIds).toHaveLength(2);
    expect(out.invoiceId).toBeTruthy();
    const r = await admin.reservation.findUniqueOrThrow({ where: { id: res.id } });
    expect(r.status).toBe("CHECKED_OUT");
    expect(r.checkedOutBy).toBe(owner.userId);
    expect(r.actualDeparture!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const asg = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: res.id } });
    expect(asg.active).toBe(false);
    expect(await admin.room.findUniqueOrThrow({ where: { id: asg.roomId } })).toMatchObject({ housekeeping: "DIRTY", dnd: false });
    const task = await admin.housekeepingTask.findFirstOrThrow({ where: { roomId: asg.roomId, reservationId: res.id } });
    expect(task).toMatchObject({ kind: "DEPARTURE", status: "PENDING", updatedBy: owner.userId });
    expect(await admin.auditLog.count({ where: { entityId: res.id, action: "reservation.checked_out" } })).toBe(1);
    expect(await admin.roomStatusHistory.count({ where: { roomId: asg.roomId, toState: "DIRTY", reason: "Guest checked out" } })).toBeGreaterThan(0);
  });

  it("notifies housekeeping once, and only staff who may see it", async () => {
    const res = await stay();
    await completeCheckout(app, owner, res.id, { payments: [{ method: "UPI", amountMinor: 400_000, idempotencyKey: key() }], confirmed: true });
    const hk = as(owner, "HOUSEKEEPING");
    const mine = (await listNotifications(app, hk)).filter((x) => x.kind === "ROOM_CHECKED_OUT");
    expect(mine.length).toBeGreaterThan(0);
    const dupes = await admin.appNotification.count({ where: { propertyId: owner.propertyId!, dedupeKey: `checkout:${res.id}` } });
    expect(dupes).toBe(1);
    const before = await unreadNotificationCount(app, hk);
    expect(before).toBeGreaterThan(0);
    await markNotificationsRead(app, hk);
    expect(await unreadNotificationCount(app, hk)).toBe(0);
    expect(await listNotifications(app, other)).toEqual([]); // another business sees nothing
    const maint = as(owner, "MAINTENANCE");
    expect((await listNotifications(app, maint)).filter((x) => x.kind === "ROOM_CHECKED_OUT")).toEqual([]); // no housekeeping.view
  });

  it("rolls everything back when a later step fails: no payment, invoice, status change or task", async () => {
    const res = await stay();
    const folioId = await folioOf(res.id).catch(() => null);
    const reuse = key();
    // The second payment reuses the first one's key with a different amount, which fails after the first was recorded.
    await expect(completeCheckout(app, owner, res.id, {
      payments: [{ method: "UPI", amountMinor: 100_000, idempotencyKey: reuse }, { method: "CARD", amountMinor: 50_000, idempotencyKey: reuse }],
      confirmed: true,
    })).rejects.toThrow(/idempotency key/);
    expect(await status(res.id)).toBe("CHECKED_IN");
    expect(await admin.payment.count({ where: { idempotencyKey: reuse } })).toBe(0);
    const f = folioId ?? (await admin.folio.findFirst({ where: { reservationId: res.id } }))?.id;
    if (f) {
      expect(await admin.invoice.count({ where: { folioId: f } })).toBe(0);
      expect(await admin.folioEntry.count({ where: { folioId: f, category: "ROOM" } })).toBe(0); // nights were not left posted either
    }
    expect(await admin.housekeepingTask.count({ where: { reservationId: res.id } })).toBe(0);
    expect((await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: res.id } })).active).toBe(true);
  });

  it("returns the first result for a repeated submission and takes no second payment", async () => {
    const res = await stay();
    const k = key();
    const input = { payments: [{ method: "UPI" as const, amountMinor: 400_000, idempotencyKey: k }], confirmed: true as const };
    const first = await completeCheckout(app, owner, res.id, input);
    const again = await completeCheckout(app, owner, res.id, input);
    expect(again).toMatchObject({ alreadyCheckedOut: true, invoiceId: first.invoiceId });
    expect(await admin.payment.count({ where: { idempotencyKey: k } })).toBe(1);
    expect(await admin.housekeepingTask.count({ where: { reservationId: res.id } })).toBe(1);
    // Two submissions at the same moment: one completes, the other sees it completed.
    const res2 = await stay();
    const k2 = key();
    const both = await Promise.allSettled([1, 2].map(() => completeCheckout(app, owner, res2.id, { payments: [{ method: "UPI", amountMinor: 400_000, idempotencyKey: k2 }], confirmed: true })));
    expect(both.every((b) => b.status === "fulfilled")).toBe(true);
    expect(await admin.payment.count({ where: { idempotencyKey: k2 } })).toBe(1);
    expect(await admin.housekeepingTask.count({ where: { reservationId: res2.id } })).toBe(1);
    expect(await status(res2.id)).toBe("CHECKED_OUT");
  });

  it("refuses an unpaid balance without an exception, and an overpayment, leaving nothing behind", async () => {
    const res = await stay();
    await expect(completeCheckout(app, owner, res.id, { confirmed: true })).rejects.toThrow(/outstanding balance of ₹4000\.00/);
    await expect(completeCheckout(app, owner, res.id, { payments: [{ method: "UPI", amountMinor: 500_000, idempotencyKey: key() }], confirmed: true })).rejects.toThrow(/more than the balance/);
    expect(await status(res.id)).toBe("CHECKED_IN");
    await expect(completeCheckout(app, owner, res.id, { payments: [{ method: "UPI", amountMinor: 400_000, idempotencyKey: key() }], confirmed: false as never })).rejects.toThrow(/Confirm the checkout/);
  });

  it("a partial payment plus an approved-unpaid exception needs billing.waive and is audited", async () => {
    const res = await stay();
    const desk = as(owner, "FRONT_DESK");
    await expect(completeCheckout(app, desk, res.id, { payments: [{ method: "UPI", amountMinor: 200_000, idempotencyKey: key() }], exception: { kind: "APPROVED_UNPAID", reason: "Pays on Friday" }, confirmed: true })).rejects.toThrow(/permission/i);
    expect(await status(res.id)).toBe("CHECKED_IN");
    expect(await admin.payment.count({ where: { folio: { reservationId: res.id } } })).toBe(0);
    const out = await completeCheckout(app, owner, res.id, { payments: [{ method: "UPI", amountMinor: 200_000, idempotencyKey: key() }], exception: { kind: "APPROVED_UNPAID", reason: "Pays on Friday" }, confirmed: true });
    expect(out.balanceMinor).toBe(200_000);
    expect(await admin.auditLog.count({ where: { entityId: res.id, action: "checkout.waive_balance" } })).toBe(1);
    expect(await status(res.id)).toBe("CHECKED_OUT");
  });

  it("is limited to the business and the right permissions", async () => {
    const res = await stay();
    await expect(completeCheckout(app, other, res.id, { confirmed: true })).rejects.toThrow(/not found|Select or create/i);
    await expect(completeCheckout(app, as(owner, "HOUSEKEEPING"), res.id, { confirmed: true })).rejects.toThrow(/permission/i);
    expect(await status(res.id)).toBe("CHECKED_IN");
  });
});
