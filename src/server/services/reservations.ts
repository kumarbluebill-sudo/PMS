import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { blockCoversDate, blockOverlapsStay } from "@/server/domain/roomBlock";
import { assertTransition, nightsBetween, type ReservationStatus } from "@/server/domain/stay";
import { audit } from "./audit";
import { folioBalance, postRoomNightsTx } from "./billing";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export const reservationSchema = z.object({
  guestId: z.string().uuid(),
  roomTypeId: z.string().uuid(),
  arrival: day,
  departure: day,
  adults: z.number().int().min(1).max(20).default(1),
  children: z.number().int().min(0).max(20).default(0),
  source: z.enum(["DIRECT", "WALK_IN", "PHONE", "EMAIL", "WEBSITE", "OTA", "AGENT", "CORPORATE"]).default("DIRECT"),
  notes: z.string().trim().max(1000).optional(),
});

const isOverlapError = (e: unknown) =>
  e instanceof Error &&
  /no_overlap|23P01|exclusion constraint/i.test(e.message + JSON.stringify((e as { meta?: unknown }).meta ?? ""));

const newReference = () => `MK-${randomBytes(4).toString("hex").toUpperCase()}`;

/** Rooms of a type that are sellable and free for [arrival, departure). */
export async function findFreeRooms(
  tx: Prisma.TransactionClient,
  propertyId: string,
  roomTypeId: string,
  arrival: string,
  departure: string,
) {
  // A block removes a room only for the dates it covers; an out-of-order flag with no open block stays excluded.
  const blocking = await tx.maintenanceRequest.findMany({
    where: { propertyId, blocksRoom: true, status: { not: "RESOLVED" } },
    select: { roomId: true, startDate: true, expectedResolution: true },
  });
  const blockedForStay = new Set(
    blocking
      .filter((b) =>
        blockOverlapsStay(
          { startDate: b.startDate ? b.startDate.toISOString().slice(0, 10) : null, expectedResolution: b.expectedResolution ? b.expectedResolution.toISOString().slice(0, 10) : null },
          arrival,
          departure,
        ),
      )
      .map((b) => b.roomId),
  );
  const hasOpenBlock = new Set(blocking.map((b) => b.roomId));
  const rooms = await tx.room.findMany({
    where: {
      propertyId,
      roomTypeId,
      id: { notIn: [...blockedForStay] },
      assignments: {
        none: { active: true, arrival: { lt: toDate(departure) }, departure: { gt: toDate(arrival) } },
      },
    },
    orderBy: { number: "asc" },
  });
  return rooms.filter((r) => !r.outOfOrder || hasOpenBlock.has(r.id));
}

export async function searchAvailability(
  db: PrismaClient,
  ctx: Ctx,
  input: { roomTypeId: string; arrival: string; departure: string },
) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  nightsBetween(input.arrival, input.departure);
  return withTenant(db, ctx.tenantId, (tx) =>
    findFreeRooms(tx, propertyId, input.roomTypeId, input.arrival, input.departure),
  );
}

export async function createReservation(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "reservations.create");
  const propertyId = requireProperty(ctx);
  const d = reservationSchema.parse(input);
  nightsBetween(d.arrival, d.departure);

  const candidates = await withTenant(db, ctx.tenantId, async (tx) => {
    const [guest, rt] = await Promise.all([
      tx.guest.findFirst({ where: { id: d.guestId } }),
      tx.roomType.findFirst({ where: { id: d.roomTypeId, propertyId } }),
    ]);
    if (!guest) throw new AppError("NOT_FOUND", "Guest not found.");
    if (!rt) throw new AppError("NOT_FOUND", "Room type not found.");
    if (d.adults > rt.maxAdults || d.children > rt.maxChildren) {
      throw new AppError("VALIDATION", "Guest count exceeds the room type's occupancy.");
    }
    return findFreeRooms(tx, propertyId, d.roomTypeId, d.arrival, d.departure);
  });

  // Each candidate is tried in its own transaction: the DB exclusion constraint is the
  // final arbiter if another receptionist grabs the room first.
  for (const room of candidates) {
    try {
      return await withTenant(db, ctx.tenantId, async (tx) => {
        const r = await tx.reservation.create({
          data: {
            tenantId: ctx.tenantId,
            propertyId,
            reference: newReference(),
            guestId: d.guestId,
            roomTypeId: d.roomTypeId,
            source: d.source,
            arrival: toDate(d.arrival),
            departure: toDate(d.departure),
            adults: d.adults,
            children: d.children,
            notes: d.notes,
            status: "CONFIRMED",
            createdBy: ctx.userId,
          },
        });
        await tx.roomAssignment.create({
          data: {
            tenantId: ctx.tenantId,
            propertyId,
            roomId: room.id,
            reservationId: r.id,
            arrival: r.arrival,
            departure: r.departure,
          },
        });
        await tx.reservationStatusHistory.create({
          data: { tenantId: ctx.tenantId, reservationId: r.id, toStatus: "CONFIRMED", changedBy: ctx.userId },
        });
        await audit(tx, ctx, {
          action: "reservation.create",
          entityType: "Reservation",
          entityId: r.id,
          after: { reference: r.reference, roomId: room.id, arrival: d.arrival, departure: d.departure },
        });
        return { ...r, roomId: room.id, roomNumber: room.number };
      });
    } catch (e) {
      if (isOverlapError(e)) continue;
      throw e;
    }
  }
  throw new AppError(
    "CONFLICT",
    "No room of this type is available for those dates. Try other dates or another room type.",
  );
}

async function transition(
  db: PrismaClient,
  ctx: Ctx,
  reservationId: string,
  to: ReservationStatus,
  extra?: (tx: Prisma.TransactionClient, r: { id: string; propertyId: string }) => Promise<void>,
  reason?: string,
) {
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const from = r.status as ReservationStatus;
    assertTransition(from, to);
    await tx.reservation.update({ where: { id: r.id }, data: { status: to } });
    await tx.reservationStatusHistory.create({
      data: { tenantId: ctx.tenantId, reservationId: r.id, fromStatus: from, toStatus: to, changedBy: ctx.userId },
    });
    if (extra) await extra(tx, r);
    await audit(tx, ctx, {
      action: `reservation.${to.toLowerCase()}`,
      entityType: "Reservation",
      entityId: r.id,
      before: { status: from },
      after: { status: to },
      reason,
    });
    return { id: r.id, status: to };
  });
}

const releaseRoom = async (tx: Prisma.TransactionClient, r: { id: string }) => {
  await tx.roomAssignment.updateMany({ where: { reservationId: r.id }, data: { active: false } });
};

export async function cancelReservation(db: PrismaClient, ctx: Ctx, id: string, reason: string) {
  authorize(ctx, "reservations.cancel");
  if (!reason.trim()) throw new AppError("VALIDATION", "A cancellation reason is required.");
  return transition(db, ctx, id, "CANCELLED", releaseRoom, reason);
}

export async function markNoShow(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "reservations.cancel");
  return transition(db, ctx, id, "NO_SHOW", releaseRoom);
}

export async function checkIn(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "frontdesk.checkin");
  return transition(db, ctx, id, "CHECKED_IN", async (tx, r) => {
    const a = await tx.roomAssignment.findFirst({
      where: { reservationId: r.id, active: true },
      include: { room: true },
    });
    if (!a) throw new AppError("CONFLICT", "No room is assigned to this reservation.");
    if (a.room.outOfOrder) throw new AppError("CONFLICT", `Room ${a.room.number} is out of order.`);
    const today = new Date().toISOString().slice(0, 10);
    const blocks = await tx.maintenanceRequest.findMany({
      where: { roomId: a.roomId, blocksRoom: true, status: { not: "RESOLVED" } },
      select: { startDate: true, expectedResolution: true, title: true },
    });
    const live = blocks.find((b) =>
      blockCoversDate(
        { startDate: b.startDate ? b.startDate.toISOString().slice(0, 10) : null, expectedResolution: b.expectedResolution ? b.expectedResolution.toISOString().slice(0, 10) : null },
        today,
      ),
    );
    if (live) throw new AppError("CONFLICT", `Room ${a.room.number} is blocked for maintenance: ${live.title}.`);
    if (a.room.housekeeping !== "CLEAN" && a.room.housekeeping !== "INSPECTED") {
      throw new AppError("CONFLICT", `Room ${a.room.number} is not ready (${a.room.housekeeping.toLowerCase()}).`);
    }
  });
}

/**
 * Posts any remaining room-night charges, then refuses to complete the stay while the folio has an outstanding
 * balance. A manager can waive it with a reason (audited).
 */
export async function checkOut(db: PrismaClient, ctx: Ctx, id: string, opts: { waiveReason?: string } = {}) {
  authorize(ctx, "frontdesk.checkout");
  return transition(db, ctx, id, "CHECKED_OUT", async (tx, r) => {
    const { folioId } = await postRoomNightsTx(tx, ctx, r.id);
    const balance = await folioBalance(tx, folioId);
    if (balance > 0) {
      if (!opts.waiveReason?.trim()) {
        throw new AppError("CONFLICT", `There is an outstanding balance of ₹${(balance / 100).toFixed(2)}. Collect payment, or ask a manager to waive it.`);
      }
      authorize(ctx, "billing.waive");
      await audit(tx, ctx, {
        action: "checkout.waive_balance", entityType: "Reservation", entityId: r.id,
        after: { balanceMinor: balance }, reason: opts.waiveReason.trim(),
      });
    }

    const a = await tx.roomAssignment.findFirst({ where: { reservationId: r.id, active: true } });
    if (a) {
      await tx.roomAssignment.update({ where: { id: a.id }, data: { active: false } });
      await tx.room.update({ where: { id: a.roomId }, data: { housekeeping: "DIRTY" } });
      await tx.housekeepingTask.create({
        data: { tenantId: ctx.tenantId, propertyId: r.propertyId, roomId: a.roomId, kind: "DEPARTURE" },
      });
    }
  });
}

export async function listReservations(
  db: PrismaClient,
  ctx: Ctx,
  filter: { status?: ReservationStatus; arrivalOn?: string; departureOn?: string } = {},
) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.reservation.findMany({
      where: {
        propertyId,
        ...(filter.status && { status: filter.status }),
        ...(filter.arrivalOn && { arrival: toDate(filter.arrivalOn) }),
        ...(filter.departureOn && { departure: toDate(filter.departureOn) }),
      },
      include: {
        guest: { select: { id: true, name: true } },
        assignments: { where: { active: true }, include: { room: true } },
      },
      orderBy: { arrival: "asc" },
      take: 200,
    }),
  );
}

export async function getReservation(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({
      where: { id, propertyId },
      include: {
        guest: true,
        assignments: { include: { room: { include: { roomType: true } } }, orderBy: { createdAt: "asc" } },
        history: { orderBy: { changedAt: "asc" } },
      },
    });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    return r;
  });
}
