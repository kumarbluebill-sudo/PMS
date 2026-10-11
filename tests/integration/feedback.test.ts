import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { hashToken } from "@/server/crypto";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createBooking } from "@/server/services/booking";
import { checkIn } from "@/server/services/reservations";
import { roomBoard } from "@/server/services/dashboard";
import {
  addFeedbackNote, complaintAlerts, createFeedbackLink, feedbackSummary, listFeedback, loadFeedbackLink, recordFeedback,
  setComplaintStatus, submitLinkedFeedback,
} from "@/server/services/feedback";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let deluxe: string;
let suite: string;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asRole = (c: Ctx, role: Ctx["role"], extra: Ctx["extra"] = []): Ctx => ({ ...c, role, extra, userId: randomUUID() });
let n = 0;
const book = async (roomTypeId: string, name = `Fiona Feedback ${++n}`) => {
  const r = await createBooking(app, owner, { newGuest: { name, mobile: `9111${String(100000 + n)}` }, roomTypeId, arrival: today, departure: addDays(today, 1), adults: 1 });
  return r.reservations[0];
};
const checkedIn = async (roomTypeId: string, name?: string) => {
  const r = await book(roomTypeId, name);
  await checkIn(app, owner, r.id);
  return r;
};

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  const mk = async (label: string) =>
    loadContext(app, {
      userId: (await registerTenant(app, { businessName: `B ${label}`, propertyName: `H ${label}`, name: "Owner", email: `fb-${label}-${sfx}@test.local`, password: "correct-horse-battery" })).userId,
      epoch: 0,
    });
  owner = await mk("a");
  other = await mk("b");
  today = (await roomBoard(app, owner)).today;
  deluxe = (await createRoomType(app, owner, { name: "Deluxe", baseRateMinor: 100_000 })).id;
  suite = (await createRoomType(app, owner, { name: "Suite", baseRateMinor: 300_000 })).id;
  for (let i = 0; i < 8; i++) await createRoom(app, owner, { roomTypeId: deluxe, number: String(100 + i) });
  for (let i = 0; i < 8; i++) await createRoom(app, owner, { roomTypeId: suite, number: String(200 + i) });
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("staff-entered feedback", () => {
  it("ties feedback to the booking and copies guest, room and dates from it", async () => {
    const res = await book(deluxe, "Asha Verma");
    const fb = await recordFeedback(app, owner, { reference: res.reference.toLowerCase(), overall: "5", cleanliness: "4", comments: "Lovely stay", recommend: "yes" });
    expect(fb).toMatchObject({ reservationId: res.id, guestName: "Asha Verma", roomNumber: res.roomNumber, roomTypeId: deluxe, overall: 5, cleanliness: 4, service: null, recommend: true, source: "STAFF", status: "NONE" });
    await expect(recordFeedback(app, owner, { reference: res.reference, overall: 3 })).rejects.toThrow(/already been recorded/);
  });

  it("validates input", async () => {
    await expect(recordFeedback(app, owner, { reference: "MK-NOPE0000", overall: 3 })).rejects.toThrow(/No booking with that reference/);
    await expect(recordFeedback(app, owner, { overall: 3 })).rejects.toThrow(/name or a booking reference/);
    await expect(recordFeedback(app, owner, { guestName: "X", overall: 0 })).rejects.toThrow(/1 to 5/);
    await expect(recordFeedback(app, owner, { guestName: "X", overall: 6 })).rejects.toThrow(/1 to 5/);
    await expect(recordFeedback(app, owner, { guestName: "X", overall: 4, food: 9 })).rejects.toThrow(/1 to 5/);
    await expect(recordFeedback(app, owner, { guestName: "X", overall: 4, arrival: "2026-10-10", departure: "2026-10-01" })).rejects.toThrow(/before check-in/);
    await expect(recordFeedback(app, other, { reference: (await book(deluxe)).reference, overall: 3 })).rejects.toThrow(/No booking with that reference/);
  });

  it("a low rating opens a complaint; a good one does not", async () => {
    const low = await recordFeedback(app, owner, { guestName: "Lena Low", overall: 2, comments: "Noisy" });
    const ok = await recordFeedback(app, owner, { guestName: "Gina Good", overall: 4 });
    expect(low.status).toBe("OPEN");
    expect(ok.status).toBe("NONE");
  });

  it("only staff with feedback.manage can record", async () => {
    await expect(recordFeedback(app, asRole(owner, "HOUSEKEEPING"), { guestName: "X", overall: 3 })).rejects.toThrow(/permission/i);
    await expect(recordFeedback(app, asRole(owner, "AUDITOR"), { guestName: "X", overall: 3 })).rejects.toThrow(/permission/i);
    await expect(recordFeedback(app, asRole(owner, "FRONT_DESK"), { guestName: "Via Desk", overall: 3 })).resolves.toBeTruthy();
  });
});

describe("guest feedback link", () => {
  it("is available only during or after the stay and stores only a hash", async () => {
    const pending = await book(suite);
    await expect(createFeedbackLink(app, owner, pending.id)).rejects.toThrow(/during or after the stay/);
    const stay = await checkedIn(suite, "Mira Mehta");
    const { token, expiresAt } = await createFeedbackLink(app, owner, stay.id);
    expect(token).toMatch(new RegExp(`^${owner.tenantId}\\.[A-Za-z0-9_-]{40,}$`));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    const row = await admin.feedbackLink.findFirstOrThrow({ where: { reservationId: stay.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token.split(".")[1]);
    await expect(createFeedbackLink(app, asRole(owner, "HOUSEKEEPING"), stay.id)).rejects.toThrow(/permission/i);
  });

  it("shows the guest only their first name, the hotel and the stay dates", async () => {
    const stay = await checkedIn(suite, "Nikhil Nair");
    const { token } = await createFeedbackLink(app, owner, stay.id);
    const link = await loadFeedbackLink(app, token);
    expect(link).toMatchObject({ state: "OK", firstName: "Nikhil", propertyName: "H a" });
    const text = JSON.stringify(link);
    expect(text).not.toContain(stay.reference);
    expect(text).not.toContain("Nair");
    expect(Object.keys(link).sort()).toEqual(["arrival", "categories", "departure", "firstName", "propertyName", "state"]);
  });

  it("accepts a submission once, attaches it to the booking and marks the link used", async () => {
    const stay = await checkedIn(suite, "Olga Oberoi");
    const { token } = await createFeedbackLink(app, owner, stay.id);
    await submitLinkedFeedback(app, token, { overall: "5", cleanliness: "5", service: "4", comments: "Great", recommend: "yes" });
    const fb = await admin.feedback.findFirstOrThrow({ where: { reservationId: stay.id } });
    expect(fb).toMatchObject({ source: "LINK", overall: 5, service: 4, guestName: "Olga Oberoi", roomNumber: stay.roomNumber, status: "NONE", submittedBy: null });
    expect((await admin.feedbackLink.findFirstOrThrow({ where: { reservationId: stay.id } })).usedAt).toBeTruthy();
    await expect(submitLinkedFeedback(app, token, { overall: 1 })).rejects.toThrow(/already been submitted/);
    expect(await loadFeedbackLink(app, token)).toEqual({ state: "USED" });
    expect(await admin.feedback.count({ where: { reservationId: stay.id } })).toBe(1);
  });

  it("is single-use even under concurrent submissions", async () => {
    const stay = await checkedIn(suite, "Paras Pillai");
    const { token } = await createFeedbackLink(app, owner, stay.id);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => submitLinkedFeedback(app, token, { overall: 4 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await admin.feedback.count({ where: { reservationId: stay.id } })).toBe(1);
  });

  it("rejects expired, malformed, tampered and cross-tenant links", async () => {
    const stay = await checkedIn(suite, "Quinn Qureshi");
    const { token } = await createFeedbackLink(app, owner, stay.id);
    const [tenant, secret] = token.split(".");
    expect(await loadFeedbackLink(app, "garbage")).toEqual({ state: "INVALID" });
    expect(await loadFeedbackLink(app, `${tenant}.${secret.slice(0, -1)}x`)).toEqual({ state: "INVALID" });
    expect(await loadFeedbackLink(app, `${other.tenantId}.${secret}`)).toEqual({ state: "INVALID" });
    await expect(submitLinkedFeedback(app, `${other.tenantId}.${secret}`, { overall: 3 })).rejects.toThrow(/not valid/);
    await expect(submitLinkedFeedback(app, "garbage", { overall: 3 })).rejects.toThrow(/not valid/);
    await expect(submitLinkedFeedback(app, token, { overall: 9 })).rejects.toThrow(/1 to 5/);
    expect(await admin.feedback.count({ where: { reservationId: stay.id } })).toBe(0); // bad attempts leave the link usable

    const expired = `${owner.tenantId}.${"E".repeat(43)}`;
    await admin.feedbackLink.create({
      data: { tenantId: owner.tenantId, propertyId: owner.propertyId!, reservationId: stay.id, tokenHash: hashToken(expired), expiresAt: new Date(Date.now() - 1000), createdBy: owner.userId },
    });
    expect(await loadFeedbackLink(app, expired)).toEqual({ state: "EXPIRED" });
    await expect(submitLinkedFeedback(app, expired, { overall: 3 })).rejects.toThrow(/expired/);
  });
});

describe("dashboard maths", () => {
  it("counts, averages, positives, lows and breakdowns are exact and filterable", async () => {
    const t = await loadContext(app, { userId: (await registerTenant(app, { businessName: "Stats", propertyName: "Stats Inn", name: "Stat Owner", email: `fb-stats-${sfx}@test.local`, password: "correct-horse-battery" })).userId, epoch: 0 });
    const rt1 = (await createRoomType(app, t, { name: "Std", baseRateMinor: 1 })).id;
    await createRoom(app, t, { roomTypeId: rt1, number: "1" });
    const stay = (await createBooking(app, t, { newGuest: { name: "Stat Guest", mobile: "9000000099" }, roomTypeId: rt1, arrival: (await roomBoard(app, t)).today, departure: addDays((await roomBoard(app, t)).today, 1) })).reservations[0];
    for (const [o, c, s] of [[5, 5, 5], [5, 4, 4], [4, 3, null], [2, 1, 2], [1, 2, 1]] as const) {
      await recordFeedback(app, t, { guestName: `G${o}${c}`, overall: o, cleanliness: c, ...(s ? { service: s } : {}), recommend: o >= 4 ? "yes" : "no" });
    }
    await recordFeedback(app, t, { reference: stay.reference, overall: 3 });
    const sum = await feedbackSummary(app, t);
    expect(sum).toMatchObject({ count: 6, average: 3.33, positive: 3, low: 2, recommendYes: 3, recommendNo: 2, openComplaints: 2 });
    expect(sum.categories.find((c) => c.key === "cleanliness")?.average).toBe(3);
    expect(sum.categories.find((c) => c.key === "service")?.average).toBe(3);
    expect(sum.categories.find((c) => c.key === "food")?.average).toBeNull();
    expect(sum.byProperty).toEqual([expect.objectContaining({ name: "Stats Inn", count: 6, average: 3.33 })]);
    expect(sum.byRoomType.find((b) => b.name === "Std")).toMatchObject({ count: 1, average: 3 });
    expect((await feedbackSummary(app, t, { maxRating: 2 })).count).toBe(2);
    expect((await feedbackSummary(app, t, { minRating: 4 })).average).toBe(4.67);
    expect((await feedbackSummary(app, t, { reference: stay.reference })).count).toBe(1);
    expect((await feedbackSummary(app, t, { from: addDays(today, 5), to: addDays(today, 9) })).count).toBe(0);
    expect((await feedbackSummary(app, t, { from: addDays(today, -1), to: addDays(today, 1) })).count).toBe(6);
    expect((await listFeedback(app, t, { status: "OPEN" })).map((r) => r.overall).sort()).toEqual([1, 2]);
    expect((await listFeedback(app, t, { roomTypeId: rt1 }))).toHaveLength(1);
  });
});

describe("privacy and permissions", () => {
  it("roles without guest access see ratings and comments but no personal details", async () => {
    const res = await book(deluxe, "Private Person");
    await recordFeedback(app, owner, { reference: res.reference, overall: 3, comments: "Fine." });
    const viewer = asRole(owner, "HOUSEKEEPING", ["feedback.view"]);
    const rows = (await listFeedback(app, viewer, { reference: undefined })).filter((r) => r.comments === "Fine.");
    expect(rows[0]).toMatchObject({ guestName: "Guest", roomNumber: null, reference: null, overall: 3 });
    const full = (await listFeedback(app, owner)).find((r) => r.comments === "Fine.");
    expect(full).toMatchObject({ guestName: "Private Person", reference: res.reference });
    await expect(listFeedback(app, asRole(owner, "HOUSEKEEPING"))).rejects.toThrow(/permission/i);
    await expect(feedbackSummary(app, asRole(owner, "RESERVATION_EXECUTIVE"))).rejects.toThrow(/permission/i);
    expect(await listFeedback(app, asRole(owner, "AUDITOR"))).toBeTruthy();
  });

  it("another business sees nothing and cannot touch these records", async () => {
    expect(await listFeedback(app, other)).toHaveLength(0);
    expect((await feedbackSummary(app, other)).count).toBe(0);
    const [any] = await listFeedback(app, owner);
    await expect(addFeedbackNote(app, other, any.id, "hello")).rejects.toThrow(/not found/i);
    await expect(setComplaintStatus(app, other, any.id, "RESOLVED")).rejects.toThrow(/not found/i);
  });
});

describe("follow-up", () => {
  it("notes and status are separate from the guest's feedback, audited, and the original is immutable", async () => {
    const fb = await recordFeedback(app, owner, { guestName: "Complaint Carl", overall: 1, comments: "Cold room" });
    expect(fb.status).toBe("OPEN");
    await addFeedbackNote(app, owner, fb.id, "Called guest, offered AC repair");
    await setComplaintStatus(app, owner, fb.id, "IN_PROGRESS");
    await setComplaintStatus(app, owner, fb.id, "RESOLVED");
    await expect(setComplaintStatus(app, owner, fb.id, "DONE")).rejects.toThrow();
    await expect(addFeedbackNote(app, owner, fb.id, " ")).rejects.toThrow(/note/i);
    await expect(addFeedbackNote(app, asRole(owner, "AUDITOR"), fb.id, "nope")).rejects.toThrow(/permission/i);
    const row = (await listFeedback(app, owner)).find((r) => r.id === fb.id)!;
    expect(row).toMatchObject({ comments: "Cold room", status: "RESOLVED" });
    expect(row.notes.map((x) => x.note)).toEqual(["Called guest, offered AC repair"]);
    const logs = await admin.auditLog.findMany({ where: { entityId: fb.id, action: "feedback.status" }, orderBy: { at: "asc" } });
    expect(logs.map((l) => (l.after as { status: string }).status)).toEqual(["IN_PROGRESS", "RESOLVED"]);

    // Database-level guarantees.
    await expect(admin.feedback.update({ where: { id: fb.id }, data: { comments: "edited" } })).rejects.toThrow(/immutable/);
    await expect(admin.feedback.update({ where: { id: fb.id }, data: { overall: 5 } })).rejects.toThrow(/immutable/);
    await expect(admin.feedback.delete({ where: { id: fb.id } })).rejects.toThrow(/cannot be deleted/);
    const note = await admin.feedbackNote.findFirstOrThrow({ where: { feedbackId: fb.id } });
    await expect(admin.feedbackNote.update({ where: { id: note.id }, data: { note: "x" } })).rejects.toThrow(/append-only/);
    await expect(admin.feedbackNote.delete({ where: { id: note.id } })).rejects.toThrow(/append-only/);
    await expect(admin.feedback.create({ data: { tenantId: owner.tenantId, propertyId: owner.propertyId!, guestName: "x", overall: 7 } })).rejects.toThrow(/feedback_ratings_check|check constraint/);
  });

  it("alerts count unresolved low ratings only and respect permissions", async () => {
    const before = (await complaintAlerts(app, owner)).open;
    const fb = await recordFeedback(app, owner, { guestName: "Alert Alia", overall: 2 });
    expect((await complaintAlerts(app, owner)).open).toBe(before + 1);
    await recordFeedback(app, owner, { guestName: "Happy Hari", overall: 5 });
    expect((await complaintAlerts(app, owner)).open).toBe(before + 1);
    await setComplaintStatus(app, owner, fb.id, "RESOLVED");
    expect((await complaintAlerts(app, owner)).open).toBe(before);
    expect((await complaintAlerts(app, asRole(owner, "HOUSEKEEPING"))).open).toBe(0);
  });
});
