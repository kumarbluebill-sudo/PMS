import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { hashToken, newToken } from "@/server/crypto";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import {
  COMPLAINT_STATUSES, FEEDBACK_CATEGORIES, LOW_RATING_MAX, initialComplaintStatus, parseFeedbackToken, roundAvg, summarizeDistribution,
} from "@/server/domain/feedback";
import { audit } from "./audit";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const rating = z.coerce.number().int().min(1, "Ratings are from 1 to 5.").max(5, "Ratings are from 1 to 5.");
const optRating = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), rating.optional());
const yesNo = z.preprocess((v) => (v === "yes" || v === true ? true : v === "no" || v === false ? false : undefined), z.boolean().optional());

const answers = {
  overall: rating,
  cleanliness: optRating,
  service: optRating,
  food: optRating,
  facilities: optRating,
  comments: z.string().trim().max(2000).optional(),
  recommend: yesNo,
  suggestions: z.string().trim().max(2000).optional(),
};
const staffSchema = z.object({
  reference: z.string().trim().max(40).optional(),
  guestName: z.string().trim().max(120).optional(),
  roomNumber: z.string().trim().max(20).optional(),
  arrival: day.optional(),
  departure: day.optional(),
  ...answers,
});
export const guestAnswersSchema = z.object(answers);

type ReservationFacts = {
  id: string; guestName: string; roomTypeId: string; arrival: Date; departure: Date; roomNumber: string | null; propertyId: string;
};

async function facts(tx: Prisma.TransactionClient, where: { id?: string; reference?: string; propertyId?: string }): Promise<ReservationFacts | null> {
  const r = await tx.reservation.findFirst({
    where,
    include: { guest: { select: { name: true } }, assignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: { select: { number: true } } } } },
  });
  if (!r) return null;
  return {
    id: r.id, guestName: r.guest.name, roomTypeId: r.roomTypeId, arrival: r.arrival, departure: r.departure,
    roomNumber: r.assignments[0]?.room.number ?? null, propertyId: r.propertyId,
  };
}

/** A member of staff records feedback on a guest's behalf, optionally tied to a booking reference. */
export async function recordFeedback(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "feedback.manage");
  const propertyId = requireProperty(ctx);
  const parsed = staffSchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Some fields are invalid.");
  const d = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx) => {
    let f: ReservationFacts | null = null;
    if (d.reference) {
      f = await facts(tx, { reference: d.reference.toUpperCase(), propertyId });
      if (!f) throw new AppError("NOT_FOUND", "No booking with that reference at this property.");
      const dup = await tx.feedback.findFirst({ where: { reservationId: f.id } });
      if (dup) throw new AppError("CONFLICT", "Feedback has already been recorded for this booking.");
    }
    const guestName = f?.guestName ?? d.guestName;
    if (!guestName) throw new AppError("VALIDATION", "Enter the guest's name or a booking reference.");
    if (d.arrival && d.departure && d.departure < d.arrival) throw new AppError("VALIDATION", "Check-out cannot be before check-in.");
    const row = await tx.feedback.create({
      data: {
        tenantId: ctx.tenantId, propertyId, reservationId: f?.id, roomTypeId: f?.roomTypeId, guestName,
        roomNumber: f?.roomNumber ?? d.roomNumber, arrival: f?.arrival ?? (d.arrival ? toDate(d.arrival) : undefined),
        departure: f?.departure ?? (d.departure ? toDate(d.departure) : undefined),
        overall: d.overall, cleanliness: d.cleanliness, service: d.service, food: d.food, facilities: d.facilities,
        comments: d.comments || undefined, recommend: d.recommend, suggestions: d.suggestions || undefined,
        source: "STAFF", status: initialComplaintStatus(d.overall), submittedBy: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "feedback.record", entityType: "Feedback", entityId: row.id, after: { overall: d.overall, reservationId: f?.id ?? null } });
    return row;
  });
}

const LINK_DAYS = 14;

/** Creates a single-use link for a guest. The plain token is returned once and never stored. */
export async function createFeedbackLink(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "feedback.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    if (r.status !== "CHECKED_IN" && r.status !== "CHECKED_OUT") {
      throw new AppError("VALIDATION", "Feedback can be requested during or after the stay.");
    }
    if (await tx.feedback.findFirst({ where: { reservationId } })) {
      throw new AppError("CONFLICT", "Feedback has already been recorded for this booking.");
    }
    const { token } = newToken();
    const full = `${ctx.tenantId}.${token}`;
    const expiresAt = new Date(Date.now() + LINK_DAYS * 86_400_000);
    const link = await tx.feedbackLink.create({
      data: { tenantId: ctx.tenantId, propertyId, reservationId, tokenHash: hashToken(full), expiresAt, createdBy: ctx.userId },
    });
    await audit(tx, ctx, { action: "feedback.link_create", entityType: "FeedbackLink", entityId: link.id, after: { reservationId, expiresAt: expiresAt.toISOString() } });
    return { token: full, expiresAt };
  });
}

export type LinkState =
  | { state: "INVALID" | "EXPIRED" | "USED" }
  | { state: "OK"; propertyName: string; firstName: string; arrival: string; departure: string; categories: readonly string[] };

/** Public. Resolves a link without a login and reveals only the guest's first name, hotel and stay dates. */
export async function loadFeedbackLink(db: PrismaClient, token: string): Promise<LinkState> {
  const p = parseFeedbackToken(token);
  if (!p) return { state: "INVALID" };
  return withTenant(db, p.tenantId, async (tx) => {
    const link = await tx.feedbackLink.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!link) return { state: "INVALID" as const };
    if (link.usedAt) return { state: "USED" as const };
    if (link.expiresAt.getTime() < Date.now()) return { state: "EXPIRED" as const };
    if (await tx.feedback.findFirst({ where: { reservationId: link.reservationId } })) return { state: "USED" as const };
    const r = await tx.reservation.findFirstOrThrow({ where: { id: link.reservationId }, include: { guest: { select: { name: true } }, property: { select: { name: true } } } });
    return {
      state: "OK" as const, propertyName: r.property.name, firstName: r.guest.name.trim().split(/\s+/)[0] ?? "Guest",
      arrival: iso(r.arrival), departure: iso(r.departure), categories: FEEDBACK_CATEGORIES.map((c) => c.key),
    };
  });
}

/** Public. Single use: the link row is locked, checked and marked used in the same transaction as the feedback. */
export async function submitLinkedFeedback(db: PrismaClient, token: string, input: unknown) {
  const p = parseFeedbackToken(token);
  if (!p) throw new AppError("NOT_FOUND", "This feedback link is not valid.");
  const parsed = guestAnswersSchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Please check your answers.");
  const d = parsed.data;
  const hash = hashToken(token);
  return withTenant(db, p.tenantId, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM feedback_links WHERE "tokenHash" = ${hash} FOR UPDATE`;
    if (locked.length === 0) throw new AppError("NOT_FOUND", "This feedback link is not valid.");
    const link = await tx.feedbackLink.findUniqueOrThrow({ where: { id: locked[0].id } });
    if (link.usedAt) throw new AppError("CONFLICT", "Feedback has already been submitted for this stay. Thank you!");
    if (link.expiresAt.getTime() < Date.now()) throw new AppError("CONFLICT", "This feedback link has expired.");
    const f = await facts(tx, { id: link.reservationId });
    if (!f) throw new AppError("NOT_FOUND", "This feedback link is not valid.");
    if (await tx.feedback.findFirst({ where: { reservationId: f.id } })) throw new AppError("CONFLICT", "Feedback has already been submitted for this stay. Thank you!");
    await tx.feedback.create({
      data: {
        tenantId: link.tenantId, propertyId: link.propertyId, reservationId: f.id, roomTypeId: f.roomTypeId, guestName: f.guestName,
        roomNumber: f.roomNumber, arrival: f.arrival, departure: f.departure,
        overall: d.overall, cleanliness: d.cleanliness, service: d.service, food: d.food, facilities: d.facilities,
        comments: d.comments || undefined, recommend: d.recommend, suggestions: d.suggestions || undefined,
        source: "LINK", status: initialComplaintStatus(d.overall),
      },
    });
    await tx.feedbackLink.update({ where: { id: link.id }, data: { usedAt: new Date() } });
    await tx.auditLog.create({
      data: { tenantId: link.tenantId, propertyId: link.propertyId, action: "feedback.submit_link", entityType: "Feedback", entityId: f.id, after: { overall: d.overall } },
    });
  });
}

const filterSchema = z.object({
  from: day.optional(),
  to: day.optional(),
  minRating: z.number().int().min(1).max(5).optional(),
  maxRating: z.number().int().min(1).max(5).optional(),
  reference: z.string().trim().max(40).optional(),
  status: z.enum(["NONE", ...COMPLAINT_STATUSES]).optional(),
  roomTypeId: z.string().uuid().optional(),
});
export type FeedbackFilter = z.input<typeof filterSchema>;

function where(propertyId: string, f: z.output<typeof filterSchema>) {
  return {
    propertyId,
    ...(f.from || f.to ? { submittedAt: { ...(f.from && { gte: toDate(f.from) }), ...(f.to && { lt: new Date(toDate(f.to).getTime() + 86_400_000) }) } } : {}),
    ...(f.minRating || f.maxRating ? { overall: { ...(f.minRating && { gte: f.minRating }), ...(f.maxRating && { lte: f.maxRating }) } } : {}),
    ...(f.status && { status: f.status }),
    ...(f.roomTypeId && { roomTypeId: f.roomTypeId }),
    ...(f.reference && { reservation: { reference: f.reference.toUpperCase() } }),
  };
}

export async function feedbackSummary(db: PrismaClient, ctx: Ctx, input: FeedbackFilter = {}) {
  authorize(ctx, "feedback.view");
  const propertyId = requireProperty(ctx);
  const f = filterSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const w = where(propertyId, f);
    const dist = await tx.feedback.groupBy({ by: ["overall"], where: w, _count: { _all: true } });
    const overall = summarizeDistribution(Object.fromEntries(dist.map((d) => [d.overall, d._count._all])));
    const avg = await tx.feedback.aggregate({ where: w, _avg: { cleanliness: true, service: true, food: true, facilities: true } });
    const recommend = await tx.feedback.groupBy({ by: ["recommend"], where: w, _count: { _all: true } });
    const open = await tx.feedback.count({ where: { ...w, overall: { lte: LOW_RATING_MAX }, status: { in: ["OPEN", "IN_PROGRESS"] } } });

    // Breakdowns for the date range: by property across everything this user can access, and by room type here.
    const rangeOnly = { ...where(propertyId, { from: f.from, to: f.to }) } as Record<string, unknown>;
    delete rangeOnly.propertyId;
    const byProp = await tx.feedback.groupBy({ by: ["propertyId"], where: { ...rangeOnly, propertyId: { in: ctx.accessiblePropertyIds } }, _count: { _all: true }, _avg: { overall: true } });
    const props = await tx.property.findMany({ where: { id: { in: byProp.map((b) => b.propertyId) } }, select: { id: true, name: true } });
    const byType = await tx.feedback.groupBy({ by: ["roomTypeId"], where: w, _count: { _all: true }, _avg: { overall: true } });
    const types = await tx.roomType.findMany({ where: { id: { in: byType.map((b) => b.roomTypeId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return {
      ...overall,
      recommendYes: recommend.find((r) => r.recommend === true)?._count._all ?? 0,
      recommendNo: recommend.find((r) => r.recommend === false)?._count._all ?? 0,
      categories: FEEDBACK_CATEGORIES.map((c) => ({ key: c.key, label: c.label, average: roundAvg(avg._avg[c.key]) })),
      byProperty: byProp.map((b) => ({ propertyId: b.propertyId, name: props.find((p) => p.id === b.propertyId)?.name ?? "Property", count: b._count._all, average: roundAvg(b._avg.overall) })),
      byRoomType: byType.map((b) => ({ roomTypeId: b.roomTypeId, name: types.find((t) => t.id === b.roomTypeId)?.name ?? "Not linked to a booking", count: b._count._all, average: roundAvg(b._avg.overall) })),
      openComplaints: open,
    };
  });
}

export async function listFeedback(db: PrismaClient, ctx: Ctx, input: FeedbackFilter = {}) {
  authorize(ctx, "feedback.view");
  const propertyId = requireProperty(ctx);
  const f = filterSchema.parse(input);
  const seeGuest = roleHasPermission(ctx.role, "guests.view", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.feedback.findMany({
      where: where(propertyId, f), orderBy: { submittedAt: "desc" }, take: 200,
      include: { reservation: { select: { reference: true } } },
    });
    const notes = await tx.feedbackNote.findMany({ where: { feedbackId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => ({
      ...r,
      // Personal details only for roles that may see guests; ratings and comments stay visible to feedback viewers.
      guestName: seeGuest ? r.guestName : "Guest",
      roomNumber: seeGuest ? r.roomNumber : null,
      reference: seeGuest ? (r.reservation?.reference ?? null) : null,
      notes: notes.filter((n) => n.feedbackId === r.id),
    }));
  });
}

/** Unresolved low-rating complaints for the current property (for the dashboard alert). */
export async function complaintAlerts(db: PrismaClient, ctx: Ctx) {
  if (!roleHasPermission(ctx.role, "feedback.view", ctx.extra) || !ctx.propertyId) return { open: 0 };
  const propertyId = ctx.propertyId;
  const open = await withTenant(db, ctx.tenantId, (tx) =>
    tx.feedback.count({ where: { propertyId, overall: { lte: LOW_RATING_MAX }, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
  );
  return { open };
}

export async function addFeedbackNote(db: PrismaClient, ctx: Ctx, feedbackId: string, note: string) {
  authorize(ctx, "feedback.manage");
  const propertyId = requireProperty(ctx);
  const text = z.string().trim().min(2, "Write a note.").max(2000).parse(note);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const fb = await tx.feedback.findFirst({ where: { id: feedbackId, propertyId } });
    if (!fb) throw new AppError("NOT_FOUND", "Feedback not found.");
    const n = await tx.feedbackNote.create({ data: { tenantId: ctx.tenantId, feedbackId, note: text, authorId: ctx.userId } });
    await audit(tx, ctx, { action: "feedback.note", entityType: "Feedback", entityId: feedbackId });
    return n;
  });
}

export async function setComplaintStatus(db: PrismaClient, ctx: Ctx, feedbackId: string, status: string) {
  authorize(ctx, "feedback.manage");
  const propertyId = requireProperty(ctx);
  const next = z.enum(COMPLAINT_STATUSES).parse(status);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const fb = await tx.feedback.findFirst({ where: { id: feedbackId, propertyId } });
    if (!fb) throw new AppError("NOT_FOUND", "Feedback not found.");
    if (fb.status === next) return fb;
    const done = await tx.feedback.update({ where: { id: fb.id }, data: { status: next } });
    await audit(tx, ctx, { action: "feedback.status", entityType: "Feedback", entityId: fb.id, before: { status: fb.status }, after: { status: next } });
    return done;
  });
}
