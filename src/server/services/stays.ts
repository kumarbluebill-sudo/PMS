import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { nightsBetween } from "@/server/domain/stay";
import { addDays as addDaysIso, barPlacement, stayEdges } from "@/server/domain/rack";
import { blockOverlapsStay } from "@/server/domain/roomBlock";
import { audit } from "./audit";
import { findFreeRooms } from "./availability";

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
    const rooms = await tx.room.findMany({ where: { propertyId, active: true }, include: { roomType: true }, orderBy: { number: "asc" } });
    const assignments = await tx.roomAssignment.findMany({
      where: { propertyId, active: true, arrival: { lt: to }, departure: { gt: from } },
      include: { reservation: { include: { guest: { select: { name: true } } } } },
    });
    return { rooms, assignments, from, days };
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

export type RackFilter = { start: string; days: number; buildingId?: string; floorId?: string; roomTypeId?: string; q?: string; show?: "all" | "occupied" | "vacant" };

/**
 * Room rack: rooms by dates with reservation bars, maintenance blocks and conflict flags. A bar is flagged when it
 * overlaps a block on the same room (the database already prevents two stays in one room).
 */
export async function rack(db: PrismaClient, ctx: Ctx, f: RackFilter) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  day.parse(f.start);
  const days = Math.min(60, Math.max(1, f.days));
  const end = addDaysIso(f.start, days);
  const q = f.q?.trim().toLowerCase();
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [rooms, buildings, floors, types] = await Promise.all([
      tx.room.findMany({
        // Archived rooms stay visible only where they still carry a stay in this window.
        where: { propertyId, OR: [{ active: true }, { assignments: { some: { arrival: { lt: toDate(end) }, departure: { gt: toDate(f.start) } } } }], ...(f.buildingId && { buildingId: f.buildingId }), ...(f.floorId && { floorId: f.floorId }), ...(f.roomTypeId && { roomTypeId: f.roomTypeId }) },
        include: { roomType: { select: { name: true } }, floorRef: { select: { label: true } }, building: { select: { name: true } } },
        orderBy: { number: "asc" },
      }),
      tx.building.findMany({ where: { propertyId, active: true }, orderBy: { sortOrder: "asc" } }),
      tx.floor.findMany({ where: { propertyId, active: true }, orderBy: [{ sortOrder: "asc" }, { level: "asc" }] }),
      tx.roomType.findMany({ where: { propertyId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    const roomIds = rooms.map((r) => r.id);
    const [assignments, blocks] = await Promise.all([
      tx.roomAssignment.findMany({
        where: { propertyId, roomId: { in: roomIds }, arrival: { lt: toDate(end) }, departure: { gt: toDate(f.start) }, OR: [{ active: true }, { reservation: { status: "CHECKED_OUT" } }] },
        include: { reservation: { include: { guest: { select: { name: true } } } } },
      }),
      tx.maintenanceRequest.findMany({
        where: { propertyId, roomId: { in: roomIds }, blocksRoom: true, status: { not: "RESOLVED" } },
        select: { roomId: true, title: true, mode: true, startDate: true, expectedResolution: true },
      }),
    ]);
    const bars = assignments.map((a) => {
      const r = a.reservation;
      const place = barPlacement(iso(a.arrival), iso(a.departure), f.start, days)!;
      const win = blocks.filter((b) => b.roomId === a.roomId).map((b) => ({ startDate: b.startDate ? iso(b.startDate) : null, expectedResolution: b.expectedResolution ? iso(b.expectedResolution) : null }));
      const conflict = r.status !== "CHECKED_OUT" && win.some((w) => blockOverlapsStay(w, iso(a.arrival), iso(a.departure)));
      return {
        id: a.id, reservationId: r.id, roomId: a.roomId, reference: r.reference, guest: r.guest.name, status: r.status,
        arrival: iso(a.arrival), departure: iso(a.departure), vip: r.vip, conflict, ...place,
        ...stayEdges(iso(a.arrival), iso(a.departure), f.start, days),
      };
    }).filter((b) => b.span > 0);
    const blockBars = blocks.flatMap((b) => {
      const s = b.startDate ? iso(b.startDate) : f.start;
      const e = b.expectedResolution ? addDaysIso(iso(b.expectedResolution), 1) : end;
      const place = barPlacement(s, e, f.start, days);
      return place ? [{ roomId: b.roomId, title: b.title, mode: b.mode, ...place }] : [];
    });
    const byRoom = (id: string) => bars.filter((b) => b.roomId === id);
    let out = rooms.map((r) => ({
      id: r.id, number: r.number, type: r.roomType.name, typeId: r.roomTypeId, building: r.building?.name ?? null, floor: r.floorRef?.label ?? (r.floor !== null ? `Floor ${r.floor}` : null),
      housekeeping: r.housekeeping, outOfOrder: r.outOfOrder, bars: byRoom(r.id), blocks: blockBars.filter((b) => b.roomId === r.id),
    }));
    if (q) out = out.filter((r) => r.number.toLowerCase().includes(q) || r.bars.some((b) => b.guest.toLowerCase().includes(q) || b.reference.toLowerCase().includes(q)));
    if (f.show === "occupied") out = out.filter((r) => r.bars.length > 0);
    if (f.show === "vacant") out = out.filter((r) => r.bars.length === 0);
    return { rooms: out, buildings, floors, types, days, start: f.start, end };
  });
}
