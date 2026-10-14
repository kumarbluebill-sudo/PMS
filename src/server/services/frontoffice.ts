import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { encryptSecret } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { isNoShowCandidate, timeInZone } from "@/server/domain/kpi";
import { blockCoversDate } from "@/server/domain/roomBlock";
import { dateInZone } from "@/server/domain/roomStatus";
import { audit } from "./audit";
import { findFreeRooms, toDate } from "./availability";
import { folioBalance } from "./billing";
import { ID_TYPES } from "./booking";
import { checkIn, markNoShow } from "./reservations";
import { loadSettings } from "./settings";
import { moveRoom } from "./stays";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What is still missing on a reservation before the guest can be registered. Pure, so it is easy to test. */
export function registrationIssues(g: { phone: string | null; idNumberEnc: string | null; idType: string | null }, r: { registrationCompletedAt: Date | null }): string[] {
  const out: string[] = [];
  if (!g.phone) out.push("Mobile number missing");
  if (!g.idNumberEnc) out.push("ID not recorded");
  if (!r.registrationCompletedAt) out.push("Registration not completed");
  return out;
}

export type OpsRow = {
  id: string;
  reference: string;
  guest: string;
  status: string;
  source: string;
  room: string | null;
  /** True when the assigned room is clean (or inspected) and not out of order. Null when no room is assigned. */
  roomReady: boolean | null;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  vip: boolean;
  notes: string | null;
  etaTime: string | null;
  earlyCheckinRequest: string | null;
  lateCheckoutRequest: string | null;
  idVerified: boolean;
  registrationComplete: boolean;
  issues: string[];
  /** Null when the viewer cannot see billing. */
  balanceMinor: number | null;
};

export type Operations = {
  date: string;
  today: string;
  now: string;
  noShowCutoff: string;
  canSeeBalances: boolean;
  arrivalsExpected: OpsRow[];
  yetToArrive: OpsRow[];
  inHouse: OpsRow[];
  departuresExpected: OpsRow[];
  checkedOutToday: OpsRow[];
  overdueDepartures: OpsRow[];
  toConfirm: OpsRow[];
  incompleteRegistration: OpsRow[];
  unpaid: OpsRow[];
  earlyRequests: OpsRow[];
  lateRequests: OpsRow[];
  conflicts: (OpsRow & { conflict: string })[];
  vipOrSpecial: OpsRow[];
  noShowCandidates: OpsRow[];
  unassigned: OpsRow[];
};

/** All of today's front-office worklists in one pass. Every row carries the reservation id so it can link through. */
export async function operations(db: PrismaClient, ctx: Ctx, input: { date?: string } = {}): Promise<Operations> {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  const canBalances = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().parse(input.date);

  return withTenant(db, ctx.tenantId, async (tx) => {
    const prop = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
    const now = new Date();
    const today = dateInZone(now, prop.timezone);
    const date = day ?? today;
    const nowTime = timeInZone(now, prop.timezone);
    const settings = await loadSettings(tx, ctx.tenantId, propertyId);
    const cutoff = String(settings["frontoffice.noShowCutoffTime"] ?? "22:00");

    const live = await tx.reservation.findMany({
      where: {
        propertyId,
        OR: [
          { status: { in: ["CONFIRMED", "TENTATIVE", "INQUIRY"] }, arrival: { lte: toDate(date) } },
          { status: "TENTATIVE", arrival: { gte: toDate(date) } },
          { status: "CHECKED_IN" },
          { status: "CHECKED_OUT", departure: toDate(date) },
        ],
      },
      include: {
        guest: { select: { name: true, phone: true, idNumberEnc: true, idType: true } },
        assignments: { where: { active: true }, include: { room: { select: { id: true, number: true, outOfOrder: true, housekeeping: true } } }, take: 1 },
      },
      orderBy: { arrival: "asc" },
      take: 500,
    });

    // Balances for in-house stays (one query).
    const balances = new Map<string, number>();
    if (canBalances) {
      const inHouse = live.filter((r) => r.status === "CHECKED_IN").map((r) => r.id);
      const folios = await tx.folio.findMany({ where: { propertyId, label: "GUEST", reservationId: { in: inHouse } }, select: { id: true, reservationId: true } });
      for (const f of folios) balances.set(f.reservationId, await folioBalance(tx, f.id));
    }

    const blocks = await tx.maintenanceRequest.findMany({
      where: { propertyId, blocksRoom: true, status: { not: "RESOLVED" } },
      select: { roomId: true, title: true, startDate: true, expectedResolution: true },
    });
    const blockedRoom = (roomId: string, d: string) =>
      blocks.find((b) => b.roomId === roomId && blockCoversDate({ startDate: b.startDate ? iso(b.startDate) : null, expectedResolution: b.expectedResolution ? iso(b.expectedResolution) : null }, d));

    const row = (r: (typeof live)[number]): OpsRow => ({
      id: r.id, reference: r.reference, guest: r.guest.name, status: r.status,
      source: r.source, room: r.assignments[0]?.room.number ?? null,
      roomReady: r.assignments[0] ? !r.assignments[0].room.outOfOrder && ["CLEAN", "INSPECTED"].includes(r.assignments[0].room.housekeeping) : null,
      arrival: iso(r.arrival), departure: iso(r.departure),
      adults: r.adults, children: r.children, vip: r.vip, notes: r.notes, etaTime: r.etaTime,
      earlyCheckinRequest: r.earlyCheckinRequest, lateCheckoutRequest: r.lateCheckoutRequest,
      idVerified: !!r.idVerifiedAt, registrationComplete: !!r.registrationCompletedAt,
      issues: registrationIssues(r.guest, r),
      balanceMinor: canBalances && r.status === "CHECKED_IN" ? (balances.get(r.id) ?? 0) : null,
    });
    const rows = live.map((r) => ({ r, o: row(r) }));
    const pick = (f: (r: (typeof live)[number], o: OpsRow) => boolean) => rows.filter(({ r, o }) => f(r, o)).map(({ o }) => o);

    const arrivalsExpected = pick((r) => iso(r.arrival) === date && ["CONFIRMED", "CHECKED_IN"].includes(r.status));
    const conflicts: (OpsRow & { conflict: string })[] = [];
    for (const { r, o } of rows) {
      if (!["CONFIRMED", "CHECKED_IN"].includes(r.status)) continue;
      const room = r.assignments[0]?.room;
      if (!room) continue;
      const stayDate = r.status === "CHECKED_IN" ? date : iso(r.arrival);
      if (r.status === "CONFIRMED" && room.outOfOrder) conflicts.push({ ...o, conflict: `Room ${room.number} is out of order` });
      else {
        const b = blockedRoom(room.id, stayDate);
        if (b && r.status === "CONFIRMED") conflicts.push({ ...o, conflict: `Room ${room.number} is blocked: ${b.title}` });
      }
    }

    return {
      date, today, now: nowTime, noShowCutoff: cutoff, canSeeBalances: canBalances,
      arrivalsExpected,
      yetToArrive: arrivalsExpected.filter((o) => o.status === "CONFIRMED"),
      inHouse: pick((r) => r.status === "CHECKED_IN"),
      departuresExpected: pick((r) => r.status === "CHECKED_IN" && iso(r.departure) === date),
      checkedOutToday: pick((r) => r.status === "CHECKED_OUT" && iso(r.departure) === date),
      overdueDepartures: pick((r) => r.status === "CHECKED_IN" && iso(r.departure) < date),
      toConfirm: pick((r) => ["TENTATIVE", "INQUIRY"].includes(r.status)),
      incompleteRegistration: pick((r, o) => ["CONFIRMED", "CHECKED_IN"].includes(r.status) && iso(r.arrival) <= date && o.issues.length > 0),
      unpaid: pick((r, o) => r.status === "CHECKED_IN" && (o.balanceMinor ?? 0) > 0),
      earlyRequests: pick((r) => !!r.earlyCheckinRequest && r.status === "CONFIRMED" && iso(r.arrival) === date),
      lateRequests: pick((r) => !!r.lateCheckoutRequest && r.status === "CHECKED_IN" && iso(r.departure) === date),
      conflicts,
      vipOrSpecial: pick((r) => (r.vip || !!r.notes) && ["CONFIRMED", "CHECKED_IN"].includes(r.status) && iso(r.arrival) === date),
      noShowCandidates: pick((r) => r.status === "CONFIRMED" && isNoShowCandidate(iso(r.arrival), today, nowTime, cutoff)),
      unassigned: pick((r) => r.status === "CONFIRMED" && iso(r.arrival) <= date && r.assignments.length === 0),
    };
  });
}

// ---------- actions ----------

/** Assigns a room to a reservation that has none, or moves it when one is already assigned. Checked against availability. */
export async function assignRoom(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const d = z.object({ reservationId: z.string().uuid(), roomId: z.string().uuid(), reason: z.string().trim().max(200).optional() }).parse(input);
  const existing = await withTenant(db, ctx.tenantId, (tx) => tx.roomAssignment.findFirst({ where: { reservationId: d.reservationId, active: true, propertyId } }));
  if (existing) {
    if (!d.reason) throw new AppError("VALIDATION", "A reason is required to change the room.");
    return moveRoom(db, ctx, d.reservationId, d.roomId, d.reason);
  }
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: d.reservationId, propertyId } });
      if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
      if (r.status !== "CONFIRMED") throw new AppError("CONFLICT", "Rooms can only be assigned to confirmed reservations.");
      const room = await tx.room.findFirst({ where: { id: d.roomId, propertyId } });
      if (!room) throw new AppError("NOT_FOUND", "Room not found.");
      const free = await findFreeRooms(tx, propertyId, room.roomTypeId, iso(r.arrival), iso(r.departure));
      if (!free.some((x) => x.id === room.id)) throw new AppError("CONFLICT", `Room ${room.number} is not available for these dates.`);
      await tx.roomAssignment.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: room.id, reservationId: r.id, arrival: r.arrival, departure: r.departure } });
      if (room.roomTypeId !== r.roomTypeId) await tx.reservation.update({ where: { id: r.id }, data: { roomTypeId: room.roomTypeId } });
      await audit(tx, ctx, { action: "reservation.assign_room", entityType: "Reservation", entityId: r.id, after: { room: room.number } });
      return { id: r.id, roomNumber: room.number };
    });
  } catch (e) {
    if (e instanceof Error && /exclusion|overlap|23P01/i.test(`${e.message} ${(e as { code?: string }).code ?? ""}`)) throw new AppError("CONFLICT", "That room was just taken. Pick another.");
    throw e;
  }
}

const registrationSchema = z.object({
  reservationId: z.string().uuid(),
  phone: z.string().trim().min(6).max(20).optional(),
  email: z.string().trim().email().optional(),
  idType: z.enum(ID_TYPES).optional(),
  idNumber: z.string().trim().min(3).max(40).optional(),
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
});

/** Records the guest's contact and ID details (ID number encrypted) and marks registration complete when nothing is missing. */
export async function recordRegistration(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "frontdesk.checkin");
  const propertyId = requireProperty(ctx);
  const d = registrationSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: d.reservationId, propertyId }, include: { guest: true } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    if (!["CONFIRMED", "CHECKED_IN"].includes(r.status)) throw new AppError("CONFLICT", "Registration can only be recorded for confirmed or in-house guests.");
    if (d.idNumber && !d.idType) throw new AppError("VALIDATION", "Choose the ID type.");
    const guest = await tx.guest.update({
      where: { id: r.guestId },
      data: {
        ...(d.phone && { phone: d.phone }),
        ...(d.email && { email: d.email }),
        ...(d.idType && { idType: d.idType }),
        ...(d.idNumber && { idNumberEnc: encryptSecret(d.idNumber) }),
      },
    });
    const issues = registrationIssues(guest, { registrationCompletedAt: new Date() }).filter((x) => x !== "Registration not completed");
    const complete = issues.length === 0;
    await tx.reservation.update({
      where: { id: r.id },
      data: { ...(d.adults !== undefined && { adults: d.adults }), ...(d.children !== undefined && { children: d.children }), registrationCompletedAt: complete ? new Date() : null },
    });
    // Never write the ID number or phone into the audit trail.
    await audit(tx, ctx, { action: "reservation.registration", entityType: "Reservation", entityId: r.id, after: { complete, idRecorded: !!guest.idNumberEnc } });
    return { complete, issues };
  });
}

/** Staff confirm they have seen the original ID. Requires an ID to be on file. */
export async function verifyId(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "frontdesk.checkin");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId }, include: { guest: { select: { idNumberEnc: true } } } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    if (!r.guest.idNumberEnc) throw new AppError("CONFLICT", "Record the ID details before verifying.");
    await tx.reservation.update({ where: { id: r.id }, data: { idVerifiedAt: new Date(), idVerifiedBy: ctx.userId } });
    await audit(tx, ctx, { action: "reservation.id_verified", entityType: "Reservation", entityId: r.id });
  });
}

const requestsSchema = z.object({
  reservationId: z.string().uuid(),
  vip: z.boolean().optional(),
  etaTime: z.string().regex(HHMM, "Use 24-hour HH:MM.").or(z.literal("")).optional(),
  earlyCheckinRequest: z.string().trim().max(200).optional(),
  lateCheckoutRequest: z.string().trim().max(200).optional(),
});

/** VIP flag, expected arrival time and early check-in / late checkout requests. Requests are recorded, not auto-charged. */
export async function setRequests(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const d = requestsSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: d.reservationId, propertyId } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    if (!["CONFIRMED", "CHECKED_IN", "TENTATIVE"].includes(r.status)) throw new AppError("CONFLICT", "This reservation can no longer be changed.");
    await tx.reservation.update({
      where: { id: r.id },
      data: {
        ...(d.vip !== undefined && { vip: d.vip }),
        ...(d.etaTime !== undefined && { etaTime: d.etaTime || null }),
        ...(d.earlyCheckinRequest !== undefined && { earlyCheckinRequest: d.earlyCheckinRequest || null }),
        ...(d.lateCheckoutRequest !== undefined && { lateCheckoutRequest: d.lateCheckoutRequest || null }),
      },
    });
    await audit(tx, ctx, { action: "reservation.requests", entityType: "Reservation", entityId: r.id, after: { vip: d.vip, eta: d.etaTime, early: !!d.earlyCheckinRequest, late: !!d.lateCheckoutRequest } });
  });
}

/** Check-in with front-office rules: arrival date reached, and ID verified when the property requires it. */
export async function checkInGuarded(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "frontdesk.checkin");
  const propertyId = requireProperty(ctx);
  await withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId }, select: { arrival: true, idVerifiedAt: true, status: true } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const prop = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
    const today = dateInZone(new Date(), prop.timezone);
    if (r.status === "CHECKED_IN") throw new AppError("CONFLICT", "This guest is already checked in.");
    if (iso(r.arrival) > today) throw new AppError("CONFLICT", `Arrival is on ${iso(r.arrival)}. A guest cannot be checked in before the arrival date.`);
    const settings = await loadSettings(tx, ctx.tenantId, propertyId);
    if (settings["frontoffice.requireIdAtCheckin"] && !r.idVerifiedAt) throw new AppError("CONFLICT", "Verify the guest's ID before checking in.");
  });
  return checkIn(db, ctx, reservationId);
}

/** Staff-confirmed no-show. Only reservations past the configured review time qualify; the reason is recorded. */
export async function confirmNoShow(db: PrismaClient, ctx: Ctx, reservationId: string, note: string) {
  authorize(ctx, "reservations.cancel");
  const propertyId = requireProperty(ctx);
  if (!note.trim()) throw new AppError("VALIDATION", "Add a note before marking a no-show.");
  await withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId }, select: { arrival: true, status: true } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const prop = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
    const now = new Date();
    const settings = await loadSettings(tx, ctx.tenantId, propertyId);
    const cutoff = String(settings["frontoffice.noShowCutoffTime"] ?? "22:00");
    if (!isNoShowCandidate(iso(r.arrival), dateInZone(now, prop.timezone), timeInZone(now, prop.timezone), cutoff)) {
      throw new AppError("CONFLICT", `A reservation can be marked a no-show only on or after its arrival date at ${cutoff}.`);
    }
    await audit(tx, ctx, { action: "reservation.no_show_confirmed", entityType: "Reservation", entityId: reservationId, reason: note.trim() });
  });
  return markNoShow(db, ctx, reservationId);
}

export type { Prisma };

// ---------- screens: check-in and checkout context ----------

/** Everything the check-in screen needs: details, readiness checklist, eligible rooms and the money picture. */
export async function checkInContext(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  const canMoney = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  const sensitive = roleHasPermission(ctx.role, "guests.viewSensitive", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({
      where: { id: reservationId, propertyId },
      include: {
        guest: true,
        assignments: { where: { active: true }, include: { room: { include: { roomType: { select: { name: true } } } } }, take: 1 },
      },
    });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const type = await tx.roomType.findFirst({ where: { id: r.roomTypeId }, select: { name: true } });
    const settings = await loadSettings(tx, ctx.tenantId, propertyId);
    const prop = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
    const today = dateInZone(new Date(), prop.timezone);
    // Eligible rooms: free for these dates, across all categories so a room can be changed to another category.
    const types = await tx.roomType.findMany({ where: { propertyId }, select: { id: true, name: true } });
    const free: { id: string; number: string; type: string; housekeeping: string }[] = [];
    if (["CONFIRMED", "CHECKED_IN"].includes(r.status)) {
      for (const t of types) {
        for (const room of await findFreeRooms(tx, propertyId, t.id, iso(r.arrival), iso(r.departure))) free.push({ id: room.id, number: room.number, type: t.name, housekeeping: room.housekeeping });
      }
    }
    let money: { totalMinor: number; paidMinor: number; balanceMinor: number; folioId: string | null } | null = null;
    if (canMoney) {
      const folio = await tx.folio.findUnique({ where: { reservationId_label: { reservationId, label: "GUEST" } } });
      if (folio) {
        const sums = await tx.folioEntry.groupBy({ by: ["kind"], where: { folioId: folio.id }, _sum: { balanceDeltaMinor: true } });
        const s = (k: string[]) => sums.filter((x) => k.includes(x.kind)).reduce((t, x) => t + (x._sum.balanceDeltaMinor ?? 0), 0);
        money = { totalMinor: s(["CHARGE", "DISCOUNT", "REVERSAL"]), paidMinor: -s(["PAYMENT"]), balanceMinor: s(["CHARGE", "DISCOUNT", "REVERSAL", "PAYMENT", "REFUND"]), folioId: folio.id };
      } else money = { totalMinor: 0, paidMinor: 0, balanceMinor: 0, folioId: null };
    }
    const room = r.assignments[0]?.room ?? null;
    return {
      reservation: {
        id: r.id, reference: r.reference, status: r.status, source: r.source, arrival: iso(r.arrival), departure: iso(r.departure),
        adults: r.adults, children: r.children, notes: r.notes, vip: r.vip, etaTime: r.etaTime,
        earlyCheckinRequest: r.earlyCheckinRequest, lateCheckoutRequest: r.lateCheckoutRequest,
        registrationComplete: !!r.registrationCompletedAt, idVerified: !!r.idVerifiedAt, roomTypeName: type?.name ?? "",
      },
      guest: { name: r.guest.name, phone: sensitive ? r.guest.phone : r.guest.phone ? "Hidden" : null, email: sensitive ? r.guest.email : r.guest.email ? "Hidden" : null, idType: r.guest.idType, idRecorded: !!r.guest.idNumberEnc, hasPhone: !!r.guest.phone },
      room: room ? { id: room.id, number: room.number, type: room.roomType.name, housekeeping: room.housekeeping, outOfOrder: room.outOfOrder } : null,
      issues: registrationIssues(r.guest, r),
      requireId: !!settings["frontoffice.requireIdAtCheckin"],
      arrivalIsFuture: iso(r.arrival) > today,
      today,
      freeRooms: free,
      money,
    };
  });
}

/** Charges, payments and invoices for the departing guest, so checkout never hides money. */
export async function checkoutSummary(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "frontdesk.checkout");
  authorize(ctx, "billing.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({
      where: { id: reservationId, propertyId },
      include: { guest: { select: { name: true } }, assignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: { select: { number: true } } } } },
    });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const prop = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { checkOutTime: true, timezone: true } });
    const today = dateInZone(new Date(), prop.timezone);
    const folio = await tx.folio.findUnique({ where: { reservationId_label: { reservationId, label: "GUEST" } } });
    const entries = folio ? await tx.folioEntry.findMany({ where: { folioId: folio.id }, select: { kind: true, category: true, netMinor: true, taxMinor: true, balanceDeltaMinor: true } }) : [];
    const sum = (f: (e: (typeof entries)[number]) => boolean, pick: (e: (typeof entries)[number]) => number) => entries.filter(f).reduce((t, e) => t + pick(e), 0);
    const roomCharges = sum((e) => e.kind === "CHARGE" && e.category === "ROOM", (e) => e.netMinor + e.taxMinor);
    const serviceCharges = sum((e) => e.kind === "CHARGE" && e.category !== "ROOM", (e) => e.netMinor + e.taxMinor);
    const adjustments = sum((e) => e.kind === "DISCOUNT" || e.kind === "REVERSAL", (e) => e.balanceDeltaMinor);
    const paid = -sum((e) => e.kind === "PAYMENT", (e) => e.balanceDeltaMinor);
    const refunded = sum((e) => e.kind === "REFUND", (e) => e.balanceDeltaMinor);
    const balance = sum(() => true, (e) => e.balanceDeltaMinor);
    const invoices = folio ? await tx.invoice.findMany({ where: { folioId: folio.id }, select: { id: true, number: true, kind: true, grossMinor: true, issuedAt: true }, orderBy: { issuedAt: "asc" } }) : [];
    const nights = Math.round((r.departure.getTime() - r.arrival.getTime()) / 86_400_000);
    const postedNights = folio ? await tx.folioEntry.count({ where: { folioId: folio.id, idempotencyKey: { startsWith: `room:${reservationId}:` } } }) : 0;
    return {
      id: r.id, reference: r.reference, status: r.status, guest: r.guest.name, room: r.assignments[0]?.room.number ?? null,
      arrival: iso(r.arrival), departure: iso(r.departure), expectedCheckout: `${iso(r.departure)} ${prop.checkOutTime}`,
      overdue: r.status === "CHECKED_IN" && iso(r.departure) < today,
      lateCheckoutRequest: r.lateCheckoutRequest,
      folioId: folio?.id ?? null, roomCharges, serviceCharges, adjustments, paid, refunded, balance,
      unpostedNights: Math.max(0, nights - postedNights),
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, kind: i.kind, grossMinor: i.grossMinor, issuedAt: i.issuedAt.toISOString().slice(0, 10) })),
    };
  });
}

/** Housekeeping and maintenance picture for the operations panel. Housekeeping state stays separate from reservation state. */
export async function housekeepingSummary(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [rooms, tasks, requests] = await Promise.all([
      tx.room.findMany({ where: { propertyId }, select: { housekeeping: true, outOfOrder: true } }),
      tx.housekeepingTask.count({ where: { propertyId, status: { in: ["PENDING", "IN_PROGRESS"] } } }),
      tx.maintenanceRequest.findMany({ where: { propertyId, status: { not: "RESOLVED" } }, include: { room: { select: { number: true } } }, orderBy: { createdAt: "asc" } }),
    ]);
    const by = (k: string) => rooms.filter((r) => !r.outOfOrder && r.housekeeping === k).length;
    return {
      needsCleaning: by("DIRTY"), beingCleaned: by("CLEANING"), awaitingInspection: by("CLEAN"), inspectedReady: by("INSPECTED"),
      openTasks: tasks,
      openMaintenance: requests.length,
      blockedRooms: requests.filter((r) => r.blocksRoom).length,
      outOfOrder: requests.filter((r) => r.blocksRoom).slice(0, 5).map((r) => ({ id: r.id, room: r.room.number, reason: r.title })),
    };
  });
}
