import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createBooking } from "@/server/services/booking";
import { checkIn } from "@/server/services/reservations";
import { changeRoomCategory, previewCategoryChange } from "@/server/services/confirmation";
import { buildConfirmationDocument } from "@/server/services/confirmationDoc";
import { applyEmailEvent, deliverEmail, listReservationEmails, sendConfirmationEmail } from "@/server/services/emailOutbox";
import { sendEmail } from "@/server/services/accounts";
import { setConsent } from "@/server/services/messaging";
import { runStayoverForAllProperties, setDnd } from "@/server/services/housekeepingTasks";
import { propertyToday, reportIssue } from "@/server/services/roomBlocks";
import { setSettings } from "@/server/services/settings";
import type { EmailConfig, EmailMessage } from "@/server/messaging/email";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let std: string;
let dlx: string;
let n = 0;
const cfg: EmailConfig = { apiKey: "k", from: "Hotel <hotel@test.dev>", webhookSecret: null };
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const as = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });

async function tenant(label: string) {
  const r = await registerTenant(app, { businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner", email: `dl-${label}-${sfx}@test.local`, password: "correct-horse-battery" });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}
const book = async (typeId: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
  createBooking(app, owner, { newGuest: { name: `Dl Guest ${++n}`, mobile: `9600${String(100000 + n)}`, email: `dl${n}-${sfx}@test.local` }, roomTypeId: typeId, arrival: addDays(today, from), departure: addDays(today, to), adults: 2, ...extra });
const okSend = (id: string, seen: EmailMessage[] = []) => async (_c: EmailConfig, m: EmailMessage) => { seen.push(m); return { ok: true as const, id }; };

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  owner = await tenant("a");
  other = await tenant("b");
  today = await propertyToday(app, owner);
  std = (await createRoomType(app, owner, { name: "Std", maxAdults: 3, baseRateMinor: 200_000 })).id;
  dlx = (await createRoomType(app, owner, { name: "Dlx", maxAdults: 3, baseRateMinor: 350_000 })).id;
  for (const num of ["1", "2", "3", "4"]) await createRoom(app, owner, { roomTypeId: std, number: num });
  for (const num of ["11", "12"]) await createRoom(app, owner, { roomTypeId: dlx, number: num });
});
afterAll(async () => { await app.$disconnect(); await admin.$disconnect(); });

describe("email delivery", () => {
  it("records TEST and claims nothing when no provider is configured, and account emails still queue", async () => {
    const r = await deliverEmail(app, { kind: "ACCOUNT", to: "x@test.local", subject: "Hi", text: "Body" }, okSend("never"), null);
    expect(r.row).toMatchObject({ status: "TEST", provider: "none", providerId: null, sentAt: null });
    await sendEmail(app, `acct-${sfx}@test.local`, "Verify", "Click the link");
    const row = await admin.emailOutbox.findFirstOrThrow({ where: { toEmail: `acct-${sfx}@test.local` } });
    expect(["TEST", "ACCEPTED", "FAILED"]).toContain(row.status);
    expect(row.body).toBe("Click the link");
  });

  it("marks a provider-accepted email ACCEPTED (never delivered), and a refused one FAILED with the reason", async () => {
    const ok = await deliverEmail(app, { kind: "ACCOUNT", to: "a@test.local", subject: "S", text: "T" }, okSend("re_ok"), cfg);
    expect(ok.row).toMatchObject({ status: "ACCEPTED", providerId: "re_ok", provider: "resend" });
    expect(ok.row.deliveredAt).toBeNull();
    const bad = await deliverEmail(app, { kind: "ACCOUNT", to: "b@test.local", subject: "S", text: "T" }, async () => ({ ok: false, error: "Email provider refused the message (422): domain not verified." }), cfg);
    expect(bad.row).toMatchObject({ status: "FAILED", error: expect.stringContaining("domain not verified") });
  });

  it("takes provider events forward only, ignoring unknown ids and events", async () => {
    const r = await deliverEmail(app, { kind: "ACCOUNT", to: "c@test.local", subject: "S", text: "T" }, okSend(`re_${sfx}_1`), cfg);
    expect(await applyEmailEvent(app, `re_${sfx}_1`, "email.delivered")).toBe(1);
    expect((await admin.emailOutbox.findUniqueOrThrow({ where: { id: r.row.id } })).status).toBe("DELIVERED");
    expect((await admin.emailOutbox.findUniqueOrThrow({ where: { id: r.row.id } })).deliveredAt).not.toBeNull();
    expect(await applyEmailEvent(app, `re_${sfx}_1`, "email.bounced")).toBe(0); // final state stays
    expect(await applyEmailEvent(app, "re_unknown", "email.delivered")).toBe(0);
    expect(await applyEmailEvent(app, `re_${sfx}_1`, "email.opened")).toBe(0);
    const b = await deliverEmail(app, { kind: "ACCOUNT", to: "d@test.local", subject: "S", text: "T" }, okSend(`re_${sfx}_2`), cfg);
    await applyEmailEvent(app, `re_${sfx}_2`, "email.bounced");
    expect(await admin.emailOutbox.findUniqueOrThrow({ where: { id: b.row.id } })).toMatchObject({ status: "BOUNCED", error: expect.stringContaining("bounced") });
  });

  it("emails the confirmation with the PDF only with consent, a valid address, and once", async () => {
    const r = (await book(std, 5, 7)).reservations[0];
    const seen: EmailMessage[] = [];
    await expect(sendConfirmationEmail(app, owner, { reservationId: r.id }, okSend("re_c1", seen), cfg)).rejects.toThrow(/not agreed/);
    await setConsent(app, owner, { guestId: r.guestId, channel: "EMAIL", status: "GRANTED", source: "Booking form" });
    const first = await sendConfirmationEmail(app, owner, { reservationId: r.id }, okSend("re_c1", seen), cfg);
    expect(first).toMatchObject({ duplicate: false, row: { status: "ACCEPTED", kind: "CONFIRMATION", reservationId: r.id } });
    expect(seen).toHaveLength(1);
    expect(seen[0].attachments?.[0].filename).toMatch(/^confirmation-.*\.pdf$/);
    expect(Buffer.from(seen[0].attachments![0].content.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(seen[0].text).toContain(r.reference);
    const again = await sendConfirmationEmail(app, owner, { reservationId: r.id }, okSend("re_c2", seen), cfg);
    expect(again.duplicate).toBe(true);
    expect(seen).toHaveLength(1);
    expect((await sendConfirmationEmail(app, owner, { reservationId: r.id, nonce: "resend" }, okSend("re_c3", seen), cfg)).duplicate).toBe(false);
    expect((await listReservationEmails(app, owner, r.id)).map((e) => e.status)).toEqual(["ACCEPTED", "ACCEPTED"]);
    expect(await listReservationEmails(app, other, r.id)).toEqual([]);
    const audit = await admin.auditLog.findFirstOrThrow({ where: { entityId: r.id, action: "email.confirmation" } });
    expect(JSON.stringify(audit.after)).not.toContain(`dl${n}-${sfx}@test.local`); // the address is masked in the log

    const noEmail = (await createBooking(app, owner, { newGuest: { name: "No Mail", mobile: "9611111111" }, roomTypeId: std, arrival: addDays(today, 9), departure: addDays(today, 10), adults: 1 })).reservations[0];
    await setConsent(app, owner, { guestId: noEmail.guestId, channel: "EMAIL", status: "GRANTED", source: "Verbal" });
    await expect(sendConfirmationEmail(app, owner, { reservationId: noEmail.id }, okSend("x"), cfg)).rejects.toThrow(/no valid email/);
    await expect(sendConfirmationEmail(app, as(owner, "HOUSEKEEPING"), { reservationId: r.id }, okSend("x"), cfg)).rejects.toThrow(/permission/i);
  });

  it("records a provider failure on the row and in test mode says nothing was sent", async () => {
    const r = (await book(std, 11, 12)).reservations[0];
    await setConsent(app, owner, { guestId: r.guestId, channel: "EMAIL", status: "GRANTED", source: "Booking form" });
    const failed = await sendConfirmationEmail(app, owner, { reservationId: r.id }, async () => ({ ok: false, error: "Email provider could not be reached." }), cfg);
    expect(failed.row).toMatchObject({ status: "FAILED", error: expect.stringContaining("could not be reached") });
    const test = await sendConfirmationEmail(app, owner, { reservationId: r.id, nonce: "t" }, okSend("x"), null);
    expect(test.row.status).toBe("TEST");
  });
});

describe("group confirmation", () => {
  it("makes one document with a page per room for a group booking, or just one room on request", async () => {
    const g = await book(std, 15, 17, { rooms: 2 });
    expect(g.reservations).toHaveLength(2);
    const all = await buildConfirmationDocument(app, owner, g.reservations[0].id);
    expect(all.rooms).toBe(2);
    expect(all.groupRef).toBe(g.groupRef);
    expect((await PDFDocument.load(all.bytes)).getPageCount()).toBeGreaterThanOrEqual(2);
    const one = await buildConfirmationDocument(app, owner, g.reservations[0].id, { single: true });
    expect(one.rooms).toBe(1);
    expect((await PDFDocument.load(one.bytes)).getPageCount()).toBe(1);
    const solo = await buildConfirmationDocument(app, owner, (await book(std, 20, 21)).reservations[0].id);
    expect(solo.rooms).toBe(1);
    expect(solo.groupRef).toBeNull();
    await expect(buildConfirmationDocument(app, other, g.reservations[0].id)).rejects.toThrow(/not found|Select or create/i);
  });
});

describe("room category change", () => {
  it("previews then moves a booking to a free room of the new category, repricing at its rates", async () => {
    const r = (await book(std, 25, 27)).reservations[0];
    const old = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: r.id, active: true } });
    const p = await previewCategoryChange(app, owner, r.id, { roomTypeId: dlx, reason: "Upgrade" });
    expect(p).toMatchObject({ from: "Std", to: "Dlx", nights: 2, oldTotalMinor: 400_000, newTotalMinor: 700_000, differenceMinor: 300_000 });
    expect(["11", "12"]).toContain(p.room);
    const done = await changeRoomCategory(app, owner, r.id, { roomTypeId: dlx, reason: "Guest upgrade" });
    expect(done).toMatchObject({ oldTotalMinor: 400_000, newTotalMinor: 700_000 });
    const row = await admin.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ roomTypeId: dlx, quotedTotalMinor: 700_000, agreedRateMinor: 350_000 });
    expect((await admin.roomAssignment.findUniqueOrThrow({ where: { id: old.id } })).active).toBe(false);
    const now = await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: r.id, active: true } });
    expect(now.roomId).not.toBe(old.roomId);
    expect((await admin.room.findUniqueOrThrow({ where: { id: now.roomId } })).roomTypeId).toBe(dlx);
    expect(await admin.auditLog.count({ where: { entityId: r.id, action: "reservation.change_category" } })).toBe(1);
    expect((await admin.reservationStatusHistory.findFirst({ where: { reservationId: r.id, reason: { contains: "Std to Dlx" } } }))?.fromStatus).toBe("CONFIRMED");
    // The freed Std room is bookable again, the Dlx room is not.
    await expect(book(dlx, 25, 27)).resolves.toBeTruthy(); // the second Dlx room is still free
    await expect(book(dlx, 25, 27)).rejects.toThrow(/No room of this type|available/);
  });

  it("refuses when nothing is free, when a room is blocked, for too many guests, for in-house stays, and across businesses", async () => {
    // Fill both Dlx rooms for the dates.
    await book(dlx, 40, 42); await book(dlx, 40, 42);
    const r = (await book(std, 40, 42)).reservations[0];
    await expect(changeRoomCategory(app, owner, r.id, { roomTypeId: dlx, reason: "Upgrade" })).rejects.toThrow(/No Dlx room is free/);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: r.id } })).roomTypeId).toBe(std);
    expect(await admin.roomAssignment.count({ where: { reservationId: r.id, active: true } })).toBe(1);
    // A blocked room is not offered.
    const small = (await createRoomType(app, owner, { name: "Small", maxAdults: 1, baseRateMinor: 100_000 })).id;
    const sroom = (await createRoom(app, owner, { roomTypeId: small, number: "S1" })).id;
    await expect(changeRoomCategory(app, owner, r.id, { roomTypeId: small, reason: "Smaller room" })).rejects.toThrow(/takes up to 1 adult/);
    const solo = (await book(std, 45, 46, { adults: 1 })).reservations[0];
    await reportIssue(app, owner, { roomId: sroom, category: "PLUMBING", title: "Leak", mode: "OUT_OF_ORDER", acknowledgeBookings: true });
    await expect(changeRoomCategory(app, owner, solo.id, { roomTypeId: small, reason: "Downgrade" })).rejects.toThrow(/No Small room is free/);
    await expect(changeRoomCategory(app, owner, r.id, { roomTypeId: std, reason: "Same" })).rejects.toThrow(/already in that category/);
    await expect(changeRoomCategory(app, other, r.id, { roomTypeId: dlx, reason: "Hostile" })).rejects.toThrow(/not found|Select or create/i);
    await expect(changeRoomCategory(app, as(owner, "HOUSEKEEPING"), r.id, { roomTypeId: dlx, reason: "Nope" })).rejects.toThrow(/permission/i);
    await admin.room.updateMany({ where: { tenantId: owner.tenantId }, data: { housekeeping: "INSPECTED" } });
    const inHouse = (await book(std, 0, 2)).reservations[0];
    await checkIn(app, owner, inHouse.id);
    await expect(changeRoomCategory(app, owner, inHouse.id, { roomTypeId: dlx, reason: "Upgrade" })).rejects.toThrow(/pending or confirmed/);
    const stale = await admin.reservation.findUniqueOrThrow({ where: { id: solo.id } });
    await admin.reservation.update({ where: { id: solo.id }, data: { notes: "touched" } });
    await expect(changeRoomCategory(app, owner, solo.id, { roomTypeId: dlx, reason: "Late", expectedUpdatedAt: stale.updatedAt.toISOString() })).rejects.toThrow(/Someone else changed|No Dlx/);
  });
});

describe("daily stayover job", () => {
  it("only touches properties that opted in, is safe to repeat, and skips Do Not Disturb", async () => {
    await admin.room.updateMany({ where: { tenantId: owner.tenantId }, data: { housekeeping: "INSPECTED", dnd: false } });
    await admin.housekeepingTask.updateMany({ where: { tenantId: owner.tenantId }, data: { status: "CANCELLED" } });
    const a = (await book(std, 0, 3)).reservations[0];
    const b = (await book(std, 0, 3)).reservations[0];
    await checkIn(app, owner, a.id); await checkIn(app, owner, b.id);
    const roomB = (await admin.roomAssignment.findFirstOrThrow({ where: { reservationId: b.id, active: true } })).roomId;
    await setDnd(app, as(owner, "HOUSEKEEPING"), roomB, true);

    const off = await runStayoverForAllProperties(app);
    expect(await admin.housekeepingTask.count({ where: { tenantId: owner.tenantId, kind: "STAYOVER" } })).toBe(0);
    expect(off.created).toBeGreaterThanOrEqual(0);

    await setSettings(app, owner, { "housekeeping.autoStayover": true });
    try {
      const run1 = await runStayoverForAllProperties(app);
      expect(run1.optedIn).toBeGreaterThanOrEqual(1);
      const tasks = await admin.housekeepingTask.findMany({ where: { tenantId: owner.tenantId, kind: "STAYOVER" } });
      // One task for every in-house room that is not Do Not Disturb (an earlier test also left a guest in house).
      const inHouse = await admin.roomAssignment.findMany({ where: { tenantId: owner.tenantId, active: true, reservation: { status: "CHECKED_IN" } }, include: { room: true } });
      const expected = inHouse.filter((x) => !x.room.dnd).length;
      expect(expected).toBeGreaterThanOrEqual(1);
      expect(tasks).toHaveLength(expected);
      expect(tasks.some((t) => t.roomId === roomB)).toBe(false);
      expect(tasks[0].updatedBy).toBe("00000000-0000-0000-0000-000000000000");
      expect(await admin.housekeepingTask.count({ where: { tenantId: other.tenantId } })).toBe(0); // the other business never opted in
      await runStayoverForAllProperties(app);
      expect(await admin.housekeepingTask.count({ where: { tenantId: owner.tenantId, kind: "STAYOVER" } })).toBe(expected);
      expect(await admin.auditLog.count({ where: { tenantId: owner.tenantId, action: "housekeeping.stayover_generated", requestId: "cron:stayover" } })).toBeGreaterThan(0);
    } finally {
      await setSettings(app, owner, { "housekeeping.autoStayover": false });
    }
  });

  it("the job endpoint refuses callers without the secret and does nothing when no secret is configured", async () => {
    const { GET } = await import("@/app/api/cron/stayover/route");
    const call = (auth?: string) => GET(new NextRequest("http://localhost/api/cron/stayover", { headers: auth ? { authorization: auth } : {} }));
    const saved = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      expect((await call("Bearer anything")).status).toBe(404);
      process.env.CRON_SECRET = "s3cret-value";
      expect((await call()).status).toBe(401);
      expect((await call("Bearer wrong")).status).toBe(401);
      const ok = await call("Bearer s3cret-value");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true });
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
  });
});
