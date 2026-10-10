import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { nightsBetween } from "@/server/domain/stay";
import { audit } from "./audit";
import { findFreeRooms } from "./reservations";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const isOverlap = (e: unknown) => e instanceof Error && /no_overlap|23P01|exclusion constraint/i.test(e.message);

/** Change the departure date of a confirmed or in-house reservation. The DB constraint rejects clashes. */
export async function changeDeparture(db: PrismaClient, ctx: Ctx, reservationId: string, newDeparture: string) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const dep = day.parse(newDeparture);
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId } });
      if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
      if (r.status !== "CONFIRMED" && r.status !== "CHECKED_IN") {
        throw new AppError("CONFLICT", "Only confirmed or in-house reservations can be changed.");
      }
      nightsBetween(iso(r.arrival), dep);
      const a = await tx.roomAssignment.findFirst({ where: { reservationId: r.id, active: true } });
      if (!a) throw new AppError("CONFLICT", "No room is assigned to this reservation.");
      await tx.roomAssignment.update({ where: { id: a.id }, data: { departure: toDate(dep) } });
      await tx.reservation.update({ where: { id: r.id }, data: { departure: toDate(dep) } });
      await audit(tx, ctx, {
        action: "reservation.change_departure", entityType: "Reservation", entityId: r.id,
        before: { departure: iso(r.departure) }, after: { departure: dep },
      });
      return { id: r.id, departure: dep };
    });
  } catch (e) {
    if (isOverlap(e)) throw new AppError("CONFLICT", "The room is booked by another guest for those dates.");
    throw e;
  }
}

/** Move a guest to another free room (any type) for the remaining stay. */
export async function moveRoom(db: PrismaClient, ctx: Ctx, reservationId: string, newRoomId: string, reason: string) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  if (!reason.trim()) throw new AppError("VALIDATION", "A reason is required for a room move.");
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId } });
      if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
      if (r.status !== "CONFIRMED" && r.status !== "CHECKED_IN") {
        throw new AppError("CONFLICT", "Only confirmed or in-house reservations can be moved.");
      }
      const target = await tx.room.findFirst({ where: { id: newRoomId, propertyId } });
      if (!target) throw new AppError("NOT_FOUND", "Room not found.");
      const free = await findFreeRooms(tx, propertyId, target.roomTypeId, iso(r.arrival), iso(r.departure));
      if (!free.some((x) => x.id === target.id)) throw new AppError("CONFLICT", `Room ${target.number} is not available.`);
      if (r.status === "CHECKED_IN" && !["CLEAN", "INSPECTED"].includes(target.housekeeping)) {
        throw new AppError("CONFLICT", `Room ${target.number} is not ready.`);
      }
      const old = await tx.roomAssignment.findFirst({ where: { reservationId: r.id, active: true }, include: { room: true } });
      if (!old) throw new AppError("CONFLICT", "No room is assigned to this reservation.");
      await tx.roomAssignment.update({ where: { id: old.id }, data: { active: false } });
      await tx.roomAssignment.create({
        data: { tenantId: ctx.tenantId, propertyId, roomId: target.id, reservationId: r.id, arrival: r.arrival, departure: r.departure },
      });
      if (r.status === "CHECKED_IN") {
        await tx.room.update({ where: { id: old.roomId }, data: { housekeeping: "DIRTY" } });
        await tx.housekeepingTask.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: old.roomId, kind: "DEPARTURE" } });
      }
      await tx.reservation.update({ where: { id: r.id }, data: { roomTypeId: target.roomTypeId } });
      await audit(tx, ctx, {
        action: "reservation.move_room", entityType: "Reservation", entityId: r.id,
        before: { room: old.room.number }, after: { room: target.number }, reason,
      });
      return { id: r.id, roomNumber: target.number };
    });
  } catch (e) {
    if (isOverlap(e)) throw new AppError("CONFLICT", "That room was just taken. Pick another.");
    throw e;
  }
}

/** Rooms x days grid for the reservation calendar. */
export async function calendar(db: PrismaClient, ctx: Ctx, start: string, days = 14) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  day.parse(start);
  const from = toDate(start);
  const to = new Date(from.getTime() + days * 86_400_000);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rooms = await tx.room.findMany({ where: { propertyId }, include: { roomType: true }, orderBy: { number: "asc" } });
    const assignments = await tx.roomAssignment.findMany({
      where: { propertyId, active: true, arrival: { lt: to }, departure: { gt: from } },
      include: { reservation: { include: { guest: { select: { name: true } } } } },
    });
    return { rooms, assignments, from, days };
  });
}

export async function resolveMaintenance(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "maintenance.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const m = await tx.maintenanceRequest.findFirst({ where: { id, propertyId } });
    if (!m) throw new AppError("NOT_FOUND", "Request not found.");
    if (m.status === "RESOLVED") return m;
    const done = await tx.maintenanceRequest.update({ where: { id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
    await audit(tx, ctx, { action: "maintenance.resolve", entityType: "MaintenanceRequest", entityId: id });
    return done;
  });
}

export async function listMaintenance(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "maintenance.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.maintenanceRequest.findMany({ where: { propertyId }, include: { room: true }, orderBy: { createdAt: "desc" }, take: 100 }),
  );
}

const propertySchema = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(300).optional(),
  timezone: z.string().trim().min(3).max(60),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/),
});

export async function updateProperty(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "settings.manage");
  const propertyId = requireProperty(ctx);
  const d = propertySchema.parse(input);
  try {
    new Intl.DateTimeFormat("en", { timeZone: d.timezone });
  } catch {
    throw new AppError("VALIDATION", "Unknown timezone.");
  }
  return withTenant(db, ctx.tenantId, async (tx) => {
    const before = await tx.property.findFirstOrThrow({ where: { id: propertyId } });
    const p = await tx.property.update({ where: { id: propertyId }, data: d });
    await audit(tx, ctx, {
      action: "property.update", entityType: "Property", entityId: propertyId,
      before: { name: before.name, timezone: before.timezone }, after: { name: p.name, timezone: p.timezone },
    });
    return p;
  });
}
