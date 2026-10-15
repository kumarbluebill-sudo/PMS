import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { confirmationChecklist } from "@/server/domain/confirmation";
import { blockOverlapsStay } from "@/server/domain/roomBlock";
import { dateInZone } from "@/server/domain/roomStatus";
import type { RateSnapshot } from "@/server/domain/rates";
import { audit } from "./audit";
import { findFreeRooms, isOverlapError, toDate } from "./availability";
import { computeQuote, type FrozenRates } from "./booking";
import { loadSettings } from "./settings";

type Tx = Prisma.TransactionClient;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");

/** The facts and result of the pre-confirmation checklist, inside the caller's transaction. */
export async function checklistTx(tx: Tx, ctx: Ctx, reservationId: string) {
  const propertyId = requireProperty(ctx);
  const canMoney = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId }, include: { guest: true, assignments: { where: { active: true }, include: { room: { select: { number: true } } } } } });
  if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
  const [rt, property, st] = await Promise.all([
    tx.roomType.findFirstOrThrow({ where: { id: r.roomTypeId } }),
    tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } }),
    loadSettings(tx, ctx.tenantId, propertyId),
  ]);
  let paid: number | null = null;
  if (canMoney) {
    const a = await tx.folioEntry.aggregate({ where: { kind: "PAYMENT", folio: { reservationId } }, _sum: { balanceDeltaMinor: true } });
    paid = -(a._sum.balanceDeltaMinor ?? 0);
  }
  const total = r.quotedTotalMinor ?? 0;
  const snap = r.rateSnapshot as RateSnapshot | null;
  return {
    reservation: r,
    ...confirmationChecklist({
      guestName: r.guest.name, guestPhone: r.guest.phone, guestEmail: r.guest.email, arrival: iso(r.arrival), departure: iso(r.departure),
      today: dateInZone(new Date(), property.timezone), adults: r.adults, children: r.children, maxAdults: rt.maxAdults, maxChildren: rt.maxChildren,
      categoryName: rt.name, categoryActive: rt.active, roomNumber: r.assignments[0]?.room.number ?? null, hasRateSnapshot: !!snap?.nightly,
      totalMinor: total, paidMinor: paid, depositRequiredMinor: Math.floor((total * st["reservation.depositPercent"] + 50) / 100),
      cancellationPolicy: st["reservation.cancellationPolicy"],
    }),
  };
}

export async function reservationChecklist(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "reservations.view");
  requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { items, blockers, warnings, canConfirm } = await checklistTx(tx, ctx, id);
    return { items, blockers, warnings, canConfirm };
  });
}

const modSchema = z.object({
  arrival: day,
  departure: day,
  adults: z.number().int().min(1).max(100),
  children: z.number().int().min(0).max(100),
  notes: z.string().trim().max(1000).optional(),
  reason: z.string().trim().max(200).optional(),
  expectedUpdatedAt: z.string().optional(),
});
export type ModifyInput = z.input<typeof modSchema>;

/** Prices the changed stay. 'KEEP_RATE' reuses the rates booked; 'CURRENT_RATE' prices from today's rates and plans. */
async function plan(tx: Tx, ctx: Ctx, propertyId: string, id: string, d: z.output<typeof modSchema>) {
  const r = await tx.reservation.findFirst({ where: { id, propertyId } });
  if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
  if (r.status !== "TENTATIVE" && r.status !== "CONFIRMED") throw new AppError("CONFLICT", "Only a pending or confirmed booking can be changed here. For an in-house stay, extend the stay or move the room from the reservation page.");
  const property = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
  if (d.arrival < dateInZone(new Date(), property.timezone) && d.arrival !== iso(r.arrival)) throw new AppError("VALIDATION", "The new check-in cannot be in the past.");
  const st = await loadSettings(tx, ctx.tenantId, propertyId);
  const policy = st["reservation.repriceOnChange"];
  const rt = await tx.roomType.findFirstOrThrow({ where: { id: r.roomTypeId } });
  if (d.adults > rt.maxAdults || d.children > rt.maxChildren) throw new AppError("VALIDATION", `${rt.name} takes up to ${rt.maxAdults} adult(s) and ${rt.maxChildren} child(ren) per room.`);
  const snap = r.rateSnapshot as RateSnapshot | null;
  const frozen: FrozenRates | undefined = policy === "KEEP_RATE"
    ? { nightly: snap?.nightly ?? {}, fallback: r.agreedRateMinor ?? rt.baseRateMinor, extraAdultMinor: snap?.extraAdultMinor ?? rt.extraAdultRateMinor, extraChildMinor: snap?.extraChildMinor ?? rt.extraChildRateMinor, baseOccupancy: snap?.baseOccupancy ?? rt.baseOccupancy }
    : undefined;
  const quote = await computeQuote(tx, ctx, propertyId, { roomTypeId: r.roomTypeId, arrival: d.arrival, departure: d.departure, rooms: 1, adults: d.adults, children: d.children }, frozen);
  return { r, quote, policy, rt };
}

/** What a change would do to the price, without saving anything. */
export async function previewModification(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const d = modSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { r, quote, policy } = await plan(tx, ctx, propertyId, id, d);
    const oldTotal = r.quotedTotalMinor ?? 0;
    return {
      policy, nights: quote.nights, oldTotalMinor: oldTotal, newTotalMinor: quote.totalMinor, differenceMinor: quote.totalMinor - oldTotal,
      taxMinor: quote.taxMinor, nightly: quote.nightly.map((n) => ({ date: n.date, rateMinor: n.rateMinor })), plan: quote.ratePlan?.name ?? null,
      canSeeMoney: roleHasPermission(ctx.role, "billing.view", ctx.extra),
    };
  });
}

/**
 * Changes the dates, guest counts or notes of a pending or confirmed booking. The new price follows the property's
 * policy and is the one previewed; the room's assignment moves with the dates and the database refuses a clash.
 */
export async function modifyReservation(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const d = modSchema.parse(input);
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const cur = await tx.reservation.findFirst({ where: { id, propertyId } });
      if (!cur) throw new AppError("NOT_FOUND", "Reservation not found.");
      if (d.expectedUpdatedAt && new Date(d.expectedUpdatedAt).getTime() !== cur.updatedAt.getTime()) {
        throw new AppError("CONFLICT", "Someone else changed this booking while you were editing. Reload the page and check it before changing it again.");
      }
      await tx.$queryRaw`SELECT id FROM rooms WHERE "propertyId" = ${propertyId}::uuid AND "roomTypeId" = ${cur.roomTypeId}::uuid ORDER BY number FOR UPDATE`;
      const { r, quote, policy } = await plan(tx, ctx, propertyId, id, d);
      const a = await tx.roomAssignment.findFirst({ where: { reservationId: id, active: true }, include: { room: { select: { id: true, number: true } } } });
      if (a) {
        const blocks = await tx.maintenanceRequest.findMany({ where: { roomId: a.roomId, blocksRoom: true, status: { not: "RESOLVED" } }, select: { startDate: true, expectedResolution: true, title: true } });
        const hit = blocks.find((b) => blockOverlapsStay({ startDate: b.startDate ? iso(b.startDate) : null, expectedResolution: b.expectedResolution ? iso(b.expectedResolution) : null }, d.arrival, d.departure));
        if (hit) throw new AppError("CONFLICT", `Room ${a.room.number} is blocked for maintenance in those dates (${hit.title}). Move the booking to another room first.`);
        await tx.roomAssignment.update({ where: { id: a.id }, data: { arrival: toDate(d.arrival), departure: toDate(d.departure) } });
      }
      const snapshot = policy === "KEEP_RATE" ? { ...quote.snapshot } : quote.snapshot;
      const updated = await tx.reservation.update({
        where: { id },
        data: {
          arrival: toDate(d.arrival), departure: toDate(d.departure), adults: d.adults, children: d.children, notes: d.notes ?? r.notes,
          quotedTotalMinor: quote.totalMinor, rateSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          ...(policy === "CURRENT_RATE" ? { agreedRateMinor: quote.rateMinor, ratePlanId: quote.ratePlan?.id ?? null, ratePlan: quote.ratePlan?.name ?? r.ratePlan } : {}),
        },
      });
      await audit(tx, ctx, {
        action: "reservation.modify", entityType: "Reservation", entityId: id, reason: d.reason || undefined,
        before: { arrival: iso(r.arrival), departure: iso(r.departure), adults: r.adults, children: r.children, quotedTotalMinor: r.quotedTotalMinor ?? 0 },
        after: { arrival: d.arrival, departure: d.departure, adults: d.adults, children: d.children, quotedTotalMinor: quote.totalMinor, pricing: policy },
      });
      return { reservation: updated, oldTotalMinor: r.quotedTotalMinor ?? 0, newTotalMinor: quote.totalMinor };
    });
  } catch (e) {
    if (isOverlapError(e)) throw new AppError("CONFLICT", "That room is already booked for the new dates. Choose other dates or move the booking to another room.");
    throw e;
  }
}

const catSchema = z.object({
  roomTypeId: z.string().uuid(),
  roomId: z.string().uuid().optional(),
  reason: z.string().trim().min(3, "Say why the category is changing.").max(200),
  expectedUpdatedAt: z.string().optional(),
});

/** Finds a free room in the new category and prices the stay there at the category's current rates and plans. */
async function planCategory(tx: Tx, ctx: Ctx, propertyId: string, id: string, d: z.output<typeof catSchema>) {
  const r = await tx.reservation.findFirst({ where: { id, propertyId } });
  if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
  if (r.status !== "TENTATIVE" && r.status !== "CONFIRMED") throw new AppError("CONFLICT", "Only a pending or confirmed booking can change category. For an in-house guest, move the room from the reservation page.");
  if (r.roomTypeId === d.roomTypeId) throw new AppError("VALIDATION", "The booking is already in that category.");
  const [from, to] = await Promise.all([tx.roomType.findFirstOrThrow({ where: { id: r.roomTypeId } }), tx.roomType.findFirst({ where: { id: d.roomTypeId, propertyId } })]);
  if (!to) throw new AppError("NOT_FOUND", "Category not found.");
  if (!to.active) throw new AppError("VALIDATION", `"${to.name}" is not open for bookings.`);
  if (r.adults > to.maxAdults || r.children > to.maxChildren) throw new AppError("VALIDATION", `${to.name} takes up to ${to.maxAdults} adult(s) and ${to.maxChildren} child(ren) per room.`);
  const free = await findFreeRooms(tx, propertyId, to.id, iso(r.arrival), iso(r.departure));
  const room = d.roomId ? free.find((x) => x.id === d.roomId) : free[0];
  if (!room) throw new AppError("CONFLICT", d.roomId ? "That room is not free for these dates." : `No ${to.name} room is free for ${iso(r.arrival)} to ${iso(r.departure)}.`);
  const quote = await computeQuote(tx, ctx, propertyId, { roomTypeId: to.id, arrival: iso(r.arrival), departure: iso(r.departure), rooms: 1, adults: r.adults, children: r.children });
  return { r, from, to, room, quote, freeRooms: free };
}

/** What changing the category would do to the room and the price, without saving anything. */
export async function previewCategoryChange(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const d = catSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const { r, from, to, room, quote, freeRooms } = await planCategory(tx, ctx, propertyId, id, d);
    return {
      from: from.name, to: to.name, room: room.number, freeRooms: freeRooms.map((x) => ({ id: x.id, number: x.number })), nights: quote.nights,
      oldTotalMinor: r.quotedTotalMinor ?? 0, newTotalMinor: quote.totalMinor, differenceMinor: quote.totalMinor - (r.quotedTotalMinor ?? 0),
      plan: quote.ratePlan?.name ?? null, discountDropped: !!r.discountReason, canSeeMoney: roleHasPermission(ctx.role, "billing.view", ctx.extra),
    };
  });
}

/**
 * Moves a pending or confirmed booking to another room category: a free room of the new category replaces the old
 * room, and the price is worked out again at the new category's current rates (the old category's frozen rates do not
 * apply to a different kind of room, and any discount is not carried over). One transaction; the exclusion constraint
 * stays the final guard against a double booking.
 */
export async function changeRoomCategory(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const d = catSchema.parse(input);
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const cur = await tx.reservation.findFirst({ where: { id, propertyId } });
      if (!cur) throw new AppError("NOT_FOUND", "Reservation not found.");
      if (d.expectedUpdatedAt && new Date(d.expectedUpdatedAt).getTime() !== cur.updatedAt.getTime()) {
        throw new AppError("CONFLICT", "Someone else changed this booking while you were editing. Reload the page and check it before changing it again.");
      }
      await tx.$queryRaw`SELECT id FROM rooms WHERE "propertyId" = ${propertyId}::uuid AND "roomTypeId" = ${d.roomTypeId}::uuid ORDER BY number FOR UPDATE`;
      const { r, from, to, room, quote } = await planCategory(tx, ctx, propertyId, id, d);
      await tx.roomAssignment.updateMany({ where: { reservationId: id, active: true }, data: { active: false } });
      await tx.roomAssignment.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: room.id, reservationId: id, arrival: r.arrival, departure: r.departure } });
      const updated = await tx.reservation.update({
        where: { id },
        data: {
          roomTypeId: to.id, quotedTotalMinor: quote.totalMinor, rateSnapshot: quote.snapshot as unknown as Prisma.InputJsonValue,
          agreedRateMinor: quote.rateMinor, ratePlanId: quote.ratePlan?.id ?? null, ratePlan: quote.ratePlan?.name ?? "STANDARD", discountReason: null,
        },
      });
      await tx.reservationStatusHistory.create({ data: { tenantId: ctx.tenantId, reservationId: id, fromStatus: r.status, toStatus: r.status, changedBy: ctx.userId, reason: `Room category changed from ${from.name} to ${to.name}: ${d.reason}` } });
      await audit(tx, ctx, {
        action: "reservation.change_category", entityType: "Reservation", entityId: id, reason: d.reason,
        before: { category: from.name, quotedTotalMinor: r.quotedTotalMinor ?? 0 }, after: { category: to.name, room: room.number, quotedTotalMinor: quote.totalMinor },
      });
      return { reservation: updated, room: room.number, oldTotalMinor: r.quotedTotalMinor ?? 0, newTotalMinor: quote.totalMinor };
    });
  } catch (e) {
    if (isOverlapError(e)) throw new AppError("CONFLICT", "That room was just taken by another booking. Try again.");
    throw e;
  }
}

/** The facts of one reservation for its confirmation document: rates and tax per night from the booked prices. */
async function confirmationOne(tx: Tx, ctx: Ctx, propertyId: string, id: string, canMoney: boolean) {
  const r = await tx.reservation.findFirst({ where: { id, propertyId }, include: { guest: true, assignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: { select: { number: true } } } } } });
  if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
  const rt = await tx.roomType.findFirstOrThrow({ where: { id: r.roomTypeId } });
  const snap = r.rateSnapshot as RateSnapshot | null;
  const frozen: FrozenRates = {
    nightly: snap?.nightly ?? {}, fallback: r.agreedRateMinor ?? rt.baseRateMinor, extraAdultMinor: snap?.extraAdultMinor ?? rt.extraAdultRateMinor,
    extraChildMinor: snap?.extraChildMinor ?? rt.extraChildRateMinor, baseOccupancy: snap?.baseOccupancy ?? rt.baseOccupancy,
  };
  const quote = await computeQuote(tx, ctx, propertyId, { roomTypeId: r.roomTypeId, arrival: iso(r.arrival), departure: iso(r.departure), rooms: 1, adults: r.adults, children: r.children }, frozen);
  let paid: number | null = null;
  if (canMoney) {
    const a = await tx.folioEntry.aggregate({ where: { kind: "PAYMENT", folio: { reservationId: id } }, _sum: { balanceDeltaMinor: true } });
    paid = -(a._sum.balanceDeltaMinor ?? 0);
  }
  return {
    reservation: { id: r.id, reference: r.reference, status: r.status, groupRef: r.groupRef },
    guest: { name: r.guest.name, phone: r.guest.phone, email: r.guest.email },
    arrival: iso(r.arrival), departure: iso(r.departure), nights: quote.nights, adults: r.adults, children: r.children,
    category: rt.name, room: r.assignments[0]?.room.number ?? null,
    nightly: quote.nightly.map((n) => ({ date: n.date, rateMinor: n.rateMinor, taxMinor: n.taxMinor, totalMinor: n.grossMinor })),
    subtotalMinor: quote.subtotalMinor, taxMinor: quote.taxMinor, totalMinor: quote.totalMinor, paidMinor: paid, taxNote: quote.taxNote,
  };
}

/**
 * Everything the confirmation shows. For a group booking (several rooms booked together) it returns every room of the
 * group unless `single` is set, plus group totals; money is included only for staff with billing access.
 */
export async function confirmationData(db: PrismaClient, ctx: Ctx, id: string, opts: { single?: boolean } = {}) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  const canMoney = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const first = await tx.reservation.findFirst({ where: { id, propertyId }, select: { id: true, groupRef: true } });
    if (!first) throw new AppError("NOT_FOUND", "Reservation not found.");
    const ids = first.groupRef && !opts.single
      ? (await tx.reservation.findMany({ where: { tenantId: ctx.tenantId, propertyId, groupRef: first.groupRef }, orderBy: { reference: "asc" }, select: { id: true } })).map((x) => x.id)
      : [id];
    const [property, settings] = await Promise.all([tx.property.findFirstOrThrow({ where: { id: propertyId } }), loadSettings(tx, ctx.tenantId, propertyId)]);
    const items: Awaited<ReturnType<typeof confirmationOne>>[] = [];
    for (const rid of ids) items.push(await confirmationOne(tx, ctx, propertyId, rid, canMoney));
    const sum = (k: "totalMinor") => items.reduce((t, i) => t + i[k], 0);
    const group = ids.length > 1
      ? { ref: first.groupRef!, rooms: ids.length, totalMinor: sum("totalMinor"), paidMinor: canMoney ? items.reduce((t, i) => t + (i.paidMinor ?? 0), 0) : null }
      : null;
    return { property, settings, items, group, ...items[0], reservation: items.find((i) => i.reservation.id === id)!.reservation };
  });
}
