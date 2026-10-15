import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ALL_PROPERTY_ROLES, authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { dateInZone } from "@/server/domain/roomStatus";
import {
  effectiveNightRates, findPlanConflicts, MEAL_PLANS, type NightRate, type PlanInput,
} from "@/server/domain/rates";
import { audit } from "./audit";

type Tx = Prisma.TransactionClient;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const uuid = z.string().uuid();

/** Today's date at the property, from its own timezone. */
async function today(tx: Tx, propertyId: string): Promise<string> {
  const p = await tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } });
  return dateInZone(new Date(), p.timezone);
}

/** An edit form carries the `updatedAt` it was loaded with; a newer row means someone else saved first. */
function assertFresh(current: Date, expected?: string | null) {
  if (expected && new Date(expected).getTime() !== current.getTime()) {
    throw new AppError("CONFLICT", "Someone else changed this record while you were editing. Reload the page and try again.");
  }
}

/** Current and future stays that still hold this room (an in-house stay counts until check-out). */
async function liveStays(tx: Tx, roomId: string, todayIso: string) {
  const rows = await tx.roomAssignment.findMany({
    where: { roomId, active: true, departure: { gte: toDate(todayIso) } },
    include: { reservation: { select: { id: true, reference: true, status: true, guest: { select: { name: true } } } } },
    orderBy: { arrival: "asc" },
  });
  return rows.map((a) => ({ reservationId: a.reservation.id, reference: a.reservation.reference, status: a.reservation.status, guest: a.reservation.guest.name, arrival: iso(a.arrival)!, departure: iso(a.departure)! }));
}
const stayText = (s: { reference: string; guest: string; arrival: string; departure: string }[]) =>
  s.slice(0, 3).map((x) => `${x.reference} (${x.guest}, ${x.arrival} to ${x.departure})`).join("; ") + (s.length > 3 ? ` and ${s.length - 3} more` : "");

// ---------------------------------------------------------------- overview

export async function propertyOverview(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [property, rooms, archivedRooms, types, inactiveTypes, floors, buildings, plans, ratePlans] = await Promise.all([
      tx.property.findFirstOrThrow({ where: { id: propertyId } }),
      tx.room.count({ where: { propertyId, active: true } }),
      tx.room.count({ where: { propertyId, active: false } }),
      tx.roomType.count({ where: { propertyId, active: true } }),
      tx.roomType.count({ where: { propertyId, active: false } }),
      tx.floor.count({ where: { propertyId, active: true } }),
      tx.building.count({ where: { propertyId, active: true } }),
      tx.ratePlan.count({ where: { propertyId, active: true } }),
      tx.ratePlan.count({ where: { propertyId } }),
    ]);
    return { property, rooms, archivedRooms, categories: types, inactiveCategories: inactiveTypes, floors, buildings, activePlans: plans, totalPlans: ratePlans };
  });
}

// ---------------------------------------------------------------- rooms

export type RoomFilter = { q?: string; roomTypeId?: string; buildingId?: string; floorId?: string; status?: "active" | "archived" | "all"; housekeeping?: string };

export async function listRoomsAdmin(db: PrismaClient, ctx: Ctx, f: RoomFilter = {}) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  const q = f.q?.trim();
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rooms = await tx.room.findMany({
      where: {
        propertyId,
        ...(f.status === "archived" ? { active: false } : f.status === "all" ? {} : { active: true }),
        ...(f.roomTypeId && { roomTypeId: f.roomTypeId }),
        ...(f.buildingId && { buildingId: f.buildingId }),
        ...(f.floorId && { floorId: f.floorId }),
        ...(f.housekeeping && { housekeeping: f.housekeeping }),
        ...(q && { OR: [{ number: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] }),
      },
      include: { roomType: true, building: { select: { name: true } }, floorRef: { select: { label: true } } },
      orderBy: { number: "asc" },
    });
    const t = await today(tx, propertyId);
    const busy = await tx.roomAssignment.findMany({
      where: { roomId: { in: rooms.map((r) => r.id) }, active: true, departure: { gte: toDate(t) } },
      select: { roomId: true, arrival: true, reservation: { select: { status: true } } },
    });
    const inHouse = new Set(busy.filter((b) => b.reservation.status === "CHECKED_IN").map((b) => b.roomId));
    const upcoming = new Set(busy.map((b) => b.roomId));
    return rooms.map((r) => ({ ...r, inHouse: inHouse.has(r.id), hasBookings: upcoming.has(r.id) }));
  });
}

export async function getRoom(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id, propertyId }, include: { roomType: true, building: true, floorRef: true } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    const t = await today(tx, propertyId);
    const [stays, history, deps] = await Promise.all([
      liveStays(tx, id, t),
      tx.roomAssignment.count({ where: { roomId: id } }),
      roomDependents(tx, id),
    ]);
    return { room, stays, stayCount: history, deleteBlockers: deps };
  });
}

/** Reasons a room cannot be permanently deleted. Empty means it was never used. */
async function roomDependents(tx: Tx, roomId: string): Promise<string[]> {
  const [a, t, m, h] = await Promise.all([
    tx.roomAssignment.count({ where: { roomId } }), tx.housekeepingTask.count({ where: { roomId } }),
    tx.maintenanceRequest.count({ where: { roomId } }), tx.roomStatusHistory.count({ where: { roomId } }),
  ]);
  const out: string[] = [];
  if (a) out.push(`${a} reservation assignment${a === 1 ? "" : "s"}`);
  if (t) out.push(`${t} housekeeping task${t === 1 ? "" : "s"}`);
  if (m) out.push(`${m} maintenance record${m === 1 ? "" : "s"}`);
  if (h) out.push(`${h} status change${h === 1 ? "" : "s"}`);
  return out;
}

const roomEdit = z.object({
  number: z.string().trim().min(1, "Enter the room number.").max(20),
  name: z.string().trim().max(60).optional(),
  roomTypeId: uuid,
  floorId: uuid.nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  expectedUpdatedAt: z.string().optional(),
});

export async function updateRoom(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = roomEdit.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    assertFresh(room.updatedAt, d.expectedUpdatedAt);
    if (d.number !== room.number) {
      const dup = await tx.room.findFirst({ where: { propertyId, number: d.number, id: { not: id } } });
      if (dup) throw new AppError("CONFLICT", `Room ${d.number} already exists${dup.active ? "" : " (archived)"}.`);
    }
    const data: Prisma.RoomUncheckedUpdateInput = { number: d.number, name: d.name || null, notes: d.notes || null };
    if (d.roomTypeId !== room.roomTypeId) {
      const rt = await tx.roomType.findFirst({ where: { id: d.roomTypeId, propertyId } });
      if (!rt) throw new AppError("NOT_FOUND", "Category not found.");
      if (!rt.active) throw new AppError("VALIDATION", "That category is inactive.");
      const stays = await liveStays(tx, id, await today(tx, propertyId));
      if (stays.length) throw new AppError("CONFLICT", `Room ${room.number} has current or future bookings (${stayText(stays)}). Move those bookings first, then change its category.`);
      data.roomTypeId = d.roomTypeId;
    }
    if (d.floorId !== undefined && d.floorId !== room.floorId) {
      if (d.floorId === null) Object.assign(data, { floorId: null, buildingId: null, floor: null, layoutX: null, layoutY: null });
      else {
        const f = await tx.floor.findFirst({ where: { id: d.floorId, propertyId } });
        if (!f) throw new AppError("NOT_FOUND", "Floor not found.");
        if (!f.active) throw new AppError("VALIDATION", "That floor is inactive.");
        Object.assign(data, { floorId: f.id, buildingId: f.buildingId, floor: f.level, layoutX: null, layoutY: null });
      }
    }
    const updated = await tx.room.update({ where: { id }, data });
    await audit(tx, ctx, {
      action: "room.update", entityType: "Room", entityId: id,
      before: { number: room.number, name: room.name, roomTypeId: room.roomTypeId, floorId: room.floorId },
      after: { number: updated.number, name: updated.name, roomTypeId: updated.roomTypeId, floorId: updated.floorId },
    });
    return updated;
  });
}

export async function archiveRoom(db: PrismaClient, ctx: Ctx, id: string, reason: string) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  if (reason.trim().length < 3) throw new AppError("VALIDATION", "Give a reason for archiving the room.");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    if (!room.active) throw new AppError("CONFLICT", `Room ${room.number} is already archived.`);
    const stays = await liveStays(tx, id, await today(tx, propertyId));
    if (stays.length) {
      throw new AppError("CONFLICT", `Room ${room.number} cannot be archived while it holds ${stays.some((s) => s.status === "CHECKED_IN") ? "an in-house guest or " : ""}upcoming bookings: ${stayText(stays)}. Move or cancel them first.`);
    }
    await tx.room.update({ where: { id }, data: { active: false, archivedAt: new Date() } });
    await audit(tx, ctx, { action: "room.archive", entityType: "Room", entityId: id, before: { active: true }, after: { active: false }, reason: reason.trim() });
  });
}

export async function reactivateRoom(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id, propertyId }, include: { roomType: true, floorRef: true } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    if (room.active) throw new AppError("CONFLICT", `Room ${room.number} is already active.`);
    if (!room.roomType.active) throw new AppError("CONFLICT", `Its category "${room.roomType.name}" is inactive. Reactivate the category or move the room to another category first.`);
    await tx.room.update({ where: { id }, data: { active: true, archivedAt: null, ...(room.floorRef && !room.floorRef.active ? { floorId: null, buildingId: null, floor: null } : {}) } });
    await audit(tx, ctx, { action: "room.reactivate", entityType: "Room", entityId: id, before: { active: false }, after: { active: true } });
  });
}

export async function deleteRoom(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    const deps = await roomDependents(tx, id);
    if (deps.length) throw new AppError("CONFLICT", `Room ${room.number} cannot be deleted because it has ${deps.join(", ")}. Archive it instead; its history is kept.`);
    await tx.room.delete({ where: { id } });
    await audit(tx, ctx, { action: "room.delete", entityType: "Room", entityId: id, before: { number: room.number, roomTypeId: room.roomTypeId } });
  });
}

export const bulkRoomSchema = z.object({
  roomTypeId: uuid,
  floorId: uuid.optional(),
  prefix: z.string().trim().max(6).default(""),
  from: z.number().int().min(0).max(99999),
  to: z.number().int().min(0).max(99999),
  suffix: z.string().trim().max(4).default(""),
});

/** The room numbers a bulk range would create, and which ones already exist. Nothing is written. */
export async function previewBulkRooms(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = bulkRoomSchema.parse(input);
  if (d.to < d.from) throw new AppError("VALIDATION", "The last number must not be below the first.");
  if (d.to - d.from + 1 > 200) throw new AppError("VALIDATION", "Create at most 200 rooms at a time.");
  const numbers = Array.from({ length: d.to - d.from + 1 }, (_, i) => `${d.prefix}${d.from + i}${d.suffix}`);
  if (numbers.some((n) => n.length > 20)) throw new AppError("VALIDATION", "A room number would be longer than 20 characters.");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rt = await tx.roomType.findFirst({ where: { id: d.roomTypeId, propertyId } });
    if (!rt) throw new AppError("NOT_FOUND", "Category not found.");
    if (!rt.active) throw new AppError("VALIDATION", "That category is inactive.");
    const floor = d.floorId ? await tx.floor.findFirst({ where: { id: d.floorId, propertyId } }) : null;
    if (d.floorId && !floor) throw new AppError("NOT_FOUND", "Floor not found.");
    if (floor && !floor.active) throw new AppError("VALIDATION", "That floor is inactive.");
    const existing = await tx.room.findMany({ where: { propertyId, number: { in: numbers } }, select: { number: true } });
    const taken = new Set(existing.map((r) => r.number));
    return { numbers, taken: numbers.filter((n) => taken.has(n)), category: rt.name, floor: floor?.label ?? null, rt, floorRow: floor };
  });
}

export async function createRoomsBulk(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = bulkRoomSchema.parse(input);
  const p = await previewBulkRooms(db, ctx, d);
  if (p.taken.length) throw new AppError("CONFLICT", `These room numbers already exist: ${p.taken.slice(0, 8).join(", ")}${p.taken.length > 8 ? "..." : ""}. Nothing was created.`);
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.room.createMany({
      data: p.numbers.map((number) => ({
        tenantId: ctx.tenantId, propertyId, roomTypeId: d.roomTypeId, number,
        ...(p.floorRow ? { floorId: p.floorRow.id, buildingId: p.floorRow.buildingId, floor: p.floorRow.level } : {}),
      })),
    });
    await audit(tx, ctx, { action: "room.bulk_create", entityType: "Room", after: { count: p.numbers.length, first: p.numbers[0], last: p.numbers.at(-1), category: p.category } });
    return { created: p.numbers.length };
  });
}

// ---------------------------------------------------------------- categories

const typeEdit = z.object({
  name: z.string().trim().min(1, "Enter the category name.").max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,12}$/, "Code: 2 to 12 letters, digits, - or _.").optional().or(z.literal("")),
  description: z.string().trim().max(500).optional(),
  baseOccupancy: z.number().int().min(1).max(20),
  maxAdults: z.number().int().min(1).max(20),
  maxChildren: z.number().int().min(0).max(20),
  bedConfig: z.string().trim().max(80).optional(),
  amenities: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  imageUrls: z.array(z.string().trim().url().refine((u) => u.startsWith("https://"), "Photo links must start with https://")).max(10).default([]),
  baseRateMinor: z.number().int().min(0),
  extraAdultRateMinor: z.number().int().min(0),
  extraChildRateMinor: z.number().int().min(0),
  expectedUpdatedAt: z.string().optional(),
}).refine((v) => v.baseOccupancy <= v.maxAdults, { message: "Standard occupancy cannot exceed the maximum adults.", path: ["baseOccupancy"] });

export async function listCategories(db: PrismaClient, ctx: Ctx, f: { q?: string; status?: "active" | "inactive" | "all" } = {}) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  const q = f.q?.trim();
  return withTenant(db, ctx.tenantId, async (tx) => {
    const types = await tx.roomType.findMany({
      where: { propertyId, ...(f.status === "inactive" ? { active: false } : f.status === "all" ? {} : { active: true }), ...(q && { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }] }) },
      orderBy: { name: "asc" },
    });
    const counts = await tx.room.groupBy({ by: ["roomTypeId"], where: { propertyId, active: true }, _count: { _all: true } });
    return types.map((t) => ({ ...t, roomCount: counts.find((c) => c.roomTypeId === t.id)?._count._all ?? 0 }));
  });
}

export async function getCategory(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const type = await tx.roomType.findFirst({ where: { id, propertyId } });
    if (!type) throw new AppError("NOT_FOUND", "Category not found.");
    const t = await today(tx, propertyId);
    const [rooms, reservations, future, plans] = await Promise.all([
      tx.room.findMany({ where: { roomTypeId: id }, select: { id: true, number: true, active: true }, orderBy: { number: "asc" } }),
      tx.reservation.count({ where: { roomTypeId: id } }),
      tx.reservation.count({ where: { roomTypeId: id, departure: { gte: toDate(t) }, status: { in: ["TENTATIVE", "CONFIRMED", "CHECKED_IN"] } } }),
      tx.ratePlanRate.count({ where: { roomTypeId: id } }),
    ]);
    return { type, rooms, reservations, futureReservations: future, planLines: plans };
  });
}

async function assertTypeUnique(tx: Tx, propertyId: string, d: { name: string; code?: string }, selfId?: string) {
  const dupName = await tx.roomType.findFirst({ where: { propertyId, name: { equals: d.name, mode: "insensitive" }, ...(selfId && { id: { not: selfId } }) } });
  if (dupName) throw new AppError("CONFLICT", `A category called "${dupName.name}" already exists.`);
  if (d.code) {
    const dupCode = await tx.roomType.findFirst({ where: { propertyId, code: { equals: d.code, mode: "insensitive" }, ...(selfId && { id: { not: selfId } }) } });
    if (dupCode) throw new AppError("CONFLICT", `The code ${d.code} is already used by "${dupCode.name}".`);
  }
}

export async function updateCategory(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = typeEdit.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cur = await tx.roomType.findFirst({ where: { id, propertyId } });
    if (!cur) throw new AppError("NOT_FOUND", "Category not found.");
    assertFresh(cur.updatedAt, d.expectedUpdatedAt);
    await assertTypeUnique(tx, propertyId, { name: d.name, code: d.code || undefined }, id);
    const { expectedUpdatedAt: _e, code, ...rest } = d;
    void _e;
    const updated = await tx.roomType.update({ where: { id }, data: { ...rest, code: code || null, description: d.description || null, bedConfig: d.bedConfig || null } });
    const rates = (o: typeof cur) => ({ base: o.baseRateMinor, extraAdult: o.extraAdultRateMinor, extraChild: o.extraChildRateMinor });
    await audit(tx, ctx, {
      action: "roomType.update", entityType: "RoomType", entityId: id,
      before: { name: cur.name, code: cur.code, ...rates(cur), maxAdults: cur.maxAdults }, after: { name: updated.name, code: updated.code, ...rates(updated), maxAdults: updated.maxAdults },
      reason: rates(cur).base !== updated.baseRateMinor ? "Rate changed; existing bookings keep the rate they were booked at." : undefined,
    });
    return updated;
  });
}

export async function createCategoryFull(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = typeEdit.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    await assertTypeUnique(tx, propertyId, { name: d.name, code: d.code || undefined });
    const { expectedUpdatedAt: _e, code, ...rest } = d;
    void _e;
    const rt = await tx.roomType.create({ data: { ...rest, code: code || null, description: d.description || null, bedConfig: d.bedConfig || null, tenantId: ctx.tenantId, propertyId } });
    await audit(tx, ctx, { action: "roomType.create", entityType: "RoomType", entityId: rt.id, after: { name: rt.name, code: rt.code, baseRateMinor: rt.baseRateMinor } });
    return rt;
  });
}

export async function setCategoryActive(db: PrismaClient, ctx: Ctx, id: string, active: boolean, reason = "") {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  if (!active && reason.trim().length < 3) throw new AppError("VALIDATION", "Give a reason for deactivating the category.");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const t = await tx.roomType.findFirst({ where: { id, propertyId } });
    if (!t) throw new AppError("NOT_FOUND", "Category not found.");
    if (t.active === active) throw new AppError("CONFLICT", `The category is already ${active ? "active" : "inactive"}.`);
    await tx.roomType.update({ where: { id }, data: { active } });
    await audit(tx, ctx, { action: active ? "roomType.activate" : "roomType.deactivate", entityType: "RoomType", entityId: id, before: { active: t.active }, after: { active }, reason: reason.trim() || undefined });
  });
}

/** Moves rooms to another active category. Only rooms with no current or future bookings can move. */
export async function reassignRooms(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z.object({ fromTypeId: uuid, toTypeId: uuid, roomIds: z.array(uuid).min(1, "Select at least one room.").max(500) }).parse(input);
  if (d.fromTypeId === d.toTypeId) throw new AppError("VALIDATION", "Choose a different category to move the rooms to.");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const to = await tx.roomType.findFirst({ where: { id: d.toTypeId, propertyId } });
    if (!to) throw new AppError("NOT_FOUND", "Target category not found.");
    if (!to.active) throw new AppError("VALIDATION", `"${to.name}" is inactive; choose an active category.`);
    const rooms = await tx.room.findMany({ where: { id: { in: d.roomIds }, propertyId, roomTypeId: d.fromTypeId } });
    if (rooms.length !== d.roomIds.length) throw new AppError("VALIDATION", "Some selected rooms do not belong to that category.");
    const t = await today(tx, propertyId);
    for (const r of rooms) {
      const stays = await liveStays(tx, r.id, t);
      if (stays.length) throw new AppError("CONFLICT", `Room ${r.number} has current or future bookings (${stayText(stays)}), so it cannot move yet. Nothing was changed.`);
    }
    await tx.room.updateMany({ where: { id: { in: d.roomIds } }, data: { roomTypeId: d.toTypeId } });
    await audit(tx, ctx, { action: "roomType.reassign_rooms", entityType: "RoomType", entityId: d.fromTypeId, after: { to: to.name, rooms: rooms.map((r) => r.number) } });
    return { moved: rooms.length };
  });
}

export async function deleteCategory(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const t = await tx.roomType.findFirst({ where: { id, propertyId } });
    if (!t) throw new AppError("NOT_FOUND", "Category not found.");
    const [rooms, res, lines] = await Promise.all([tx.room.count({ where: { roomTypeId: id } }), tx.reservation.count({ where: { roomTypeId: id } }), tx.ratePlanRate.count({ where: { roomTypeId: id } })]);
    const why = [rooms && `${rooms} room${rooms === 1 ? "" : "s"}`, res && `${res} reservation${res === 1 ? "" : "s"}`, lines && `${lines} rate plan line${lines === 1 ? "" : "s"}`].filter(Boolean);
    if (why.length) throw new AppError("CONFLICT", `"${t.name}" cannot be deleted because it has ${why.join(", ")}. Deactivate it instead; history is kept.`);
    await tx.roomType.delete({ where: { id } });
    await audit(tx, ctx, { action: "roomType.delete", entityType: "RoomType", entityId: id, before: { name: t.name } });
  });
}

// ---------------------------------------------------------------- floors and buildings

export async function updateFloorOrBuilding(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z.object({ kind: z.enum(["building", "floor"]), id: uuid, name: z.string().trim().min(1).max(60), level: z.number().int().min(-5).max(200).optional() }).parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (d.kind === "building") {
      const b = await tx.building.findFirst({ where: { id: d.id, propertyId } });
      if (!b) throw new AppError("NOT_FOUND", "Building not found.");
      const dup = await tx.building.findFirst({ where: { propertyId, name: d.name, id: { not: d.id } } });
      if (dup) throw new AppError("CONFLICT", `A building called "${d.name}" already exists.`);
      await tx.building.update({ where: { id: d.id }, data: { name: d.name } });
      await audit(tx, ctx, { action: "building.update", entityType: "Building", entityId: d.id, before: { name: b.name }, after: { name: d.name } });
      return;
    }
    const f = await tx.floor.findFirst({ where: { id: d.id, propertyId } });
    if (!f) throw new AppError("NOT_FOUND", "Floor not found.");
    const dup = await tx.floor.findFirst({ where: { buildingId: f.buildingId, label: d.name, id: { not: d.id } } });
    if (dup) throw new AppError("CONFLICT", `A floor called "${d.name}" already exists in that building.`);
    const level = d.level ?? f.level;
    await tx.floor.update({ where: { id: d.id }, data: { label: d.name, level } });
    if (level !== f.level) await tx.room.updateMany({ where: { floorId: d.id }, data: { floor: level } });
    await audit(tx, ctx, { action: "floor.update", entityType: "Floor", entityId: d.id, before: { label: f.label, level: f.level }, after: { label: d.name, level } });
  });
}

/** Deactivation is refused while active rooms are still assigned, so no room is left on a hidden floor. */
export async function guardFloorDeactivation(tx: Tx, floorIds: string[]) {
  const rooms = await tx.room.findMany({ where: { floorId: { in: floorIds }, active: true }, select: { number: true }, orderBy: { number: "asc" } });
  if (rooms.length) {
    const list = rooms.slice(0, 6).map((r) => r.number).join(", ");
    throw new AppError("CONFLICT", `${rooms.length} active room${rooms.length === 1 ? " is" : "s are"} still assigned (${list}${rooms.length > 6 ? ", ..." : ""}). Move them to another floor first.`);
  }
}

export async function deleteFloorOrBuilding(db: PrismaClient, ctx: Ctx, kind: "building" | "floor", id: string) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  uuid.parse(id);
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (kind === "floor") {
      const f = await tx.floor.findFirst({ where: { id, propertyId } });
      if (!f) throw new AppError("NOT_FOUND", "Floor not found.");
      const n = await tx.room.count({ where: { floorId: id } });
      if (n) throw new AppError("CONFLICT", `Floor "${f.label}" cannot be deleted: ${n} room${n === 1 ? " is" : "s are"} assigned, archived ones included. Deactivate it instead.`);
      await tx.floor.delete({ where: { id } });
      await audit(tx, ctx, { action: "floor.delete", entityType: "Floor", entityId: id, before: { label: f.label } });
      return;
    }
    const b = await tx.building.findFirst({ where: { id, propertyId } });
    if (!b) throw new AppError("NOT_FOUND", "Building not found.");
    const [rooms, floors] = await Promise.all([tx.room.count({ where: { buildingId: id } }), tx.floor.count({ where: { buildingId: id } })]);
    if (rooms || floors) throw new AppError("CONFLICT", `Building "${b.name}" cannot be deleted: it has ${floors} floor${floors === 1 ? "" : "s"} and ${rooms} room${rooms === 1 ? "" : "s"}. Deactivate it instead.`);
    await tx.building.delete({ where: { id } });
    await audit(tx, ctx, { action: "building.delete", entityType: "Building", entityId: id, before: { name: b.name } });
  });
}

/** Assigns many rooms to one floor. With `dryRun` it only reports what would change. */
export async function bulkAssignFloor(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z.object({ floorId: uuid, roomIds: z.array(uuid).min(1, "Select at least one room.").max(500), dryRun: z.boolean().default(false) }).parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const f = await tx.floor.findFirst({ where: { id: d.floorId, propertyId }, include: { building: true } });
    if (!f) throw new AppError("NOT_FOUND", "Floor not found.");
    if (!f.active) throw new AppError("VALIDATION", "That floor is inactive.");
    const rooms = await tx.room.findMany({ where: { id: { in: d.roomIds }, propertyId }, include: { floorRef: { select: { label: true } } }, orderBy: { number: "asc" } });
    if (rooms.length !== d.roomIds.length) throw new AppError("NOT_FOUND", "Some selected rooms were not found.");
    const changes = rooms.map((r) => ({ id: r.id, number: r.number, from: r.floorRef?.label ?? null, to: f.label, unchanged: r.floorId === f.id }));
    if (d.dryRun) return { changes, applied: false as const };
    await tx.room.updateMany({ where: { id: { in: d.roomIds } }, data: { floorId: f.id, buildingId: f.buildingId, floor: f.level, layoutX: null, layoutY: null } });
    await audit(tx, ctx, { action: "floor.bulk_assign", entityType: "Floor", entityId: f.id, after: { rooms: rooms.map((r) => r.number), floor: f.label, building: f.building.name } });
    return { changes, applied: true as const };
  });
}

// ---------------------------------------------------------------- rate plans

const rupees = z.number().int().min(0).max(100_000_000);
const planSchema = z.object({
  name: z.string().trim().min(2, "Enter the plan name.").max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, "Code: 2 to 20 letters, digits, - or _."),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().default(true),
  validFrom: day.optional().or(z.literal("")),
  validTo: day.optional().or(z.literal("")),
  priority: z.number().int().min(0).max(100).default(0),
  weekendDays: z.array(z.number().int().min(0).max(6)).max(7).default([5, 6]),
  mealPlan: z.enum(MEAL_PLANS).default("ROOM_ONLY"),
  refundable: z.boolean().default(true),
  minStay: z.number().int().min(1).max(365).nullable().optional(),
  maxStay: z.number().int().min(1).max(365).nullable().optional(),
  taxNote: z.string().trim().max(300).optional(),
  rates: z.array(z.object({
    roomTypeId: uuid, weekdayRateMinor: rupees, weekendRateMinor: rupees.nullable().optional(), singleOccupancyRateMinor: rupees.nullable().optional(),
    extraAdultRateMinor: rupees.nullable().optional(), extraChildRateMinor: rupees.nullable().optional(),
  })).min(1, "Add a rate for at least one category.").max(100),
  expectedUpdatedAt: z.string().optional(),
}).superRefine((v, c) => {
  if (v.validFrom && v.validTo && v.validTo < v.validFrom) c.addIssue({ code: "custom", path: ["validTo"], message: "The end date must not be before the start date." });
  if (v.minStay && v.maxStay && v.maxStay < v.minStay) c.addIssue({ code: "custom", path: ["maxStay"], message: "The maximum stay must not be below the minimum." });
  const ids = v.rates.map((r) => r.roomTypeId);
  if (new Set(ids).size !== ids.length) c.addIssue({ code: "custom", path: ["rates"], message: "Each category can appear once in a plan." });
});
export type RatePlanInput = z.input<typeof planSchema>;

const toPlanInput = (p: Prisma.RatePlanGetPayload<{ include: { rates: true } }>): PlanInput => ({
  id: p.id, name: p.name, code: p.code, active: p.active, priority: p.priority, validFrom: iso(p.validFrom), validTo: iso(p.validTo),
  weekendDays: p.weekendDays, minStay: p.minStay, maxStay: p.maxStay, createdAt: p.createdAt.getTime(),
  rates: p.rates.map((r) => ({ roomTypeId: r.roomTypeId, weekdayRateMinor: r.weekdayRateMinor, weekendRateMinor: r.weekendRateMinor, singleOccupancyRateMinor: r.singleOccupancyRateMinor, extraAdultRateMinor: r.extraAdultRateMinor, extraChildRateMinor: r.extraChildRateMinor })),
});

/** All plans of a property in the shape the pricing logic uses. Also used by the booking quote. */
export async function loadPlans(tx: Tx, propertyId: string): Promise<PlanInput[]> {
  const rows = await tx.ratePlan.findMany({ where: { propertyId }, include: { rates: true } });
  return rows.map(toPlanInput);
}

export async function listRatePlans(db: PrismaClient, ctx: Ctx, f: { q?: string; status?: "active" | "archived" | "all"; roomTypeId?: string } = {}) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  const q = f.q?.trim();
  return withTenant(db, ctx.tenantId, async (tx) => {
    const plans = await tx.ratePlan.findMany({
      where: {
        propertyId,
        ...(f.status === "archived" ? { active: false } : f.status === "all" ? {} : { active: true }),
        ...(f.roomTypeId && { rates: { some: { roomTypeId: f.roomTypeId } } }),
        ...(q && { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }] }),
      },
      include: { rates: true },
      orderBy: [{ active: "desc" }, { priority: "desc" }, { name: "asc" }],
    });
    const types = await tx.roomType.findMany({ where: { propertyId }, select: { id: true, name: true } });
    return { plans, types };
  });
}

export async function getRatePlan(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const plan = await tx.ratePlan.findFirst({ where: { id, propertyId }, include: { rates: true } });
    if (!plan) throw new AppError("NOT_FOUND", "Rate plan not found.");
    const [types, used] = await Promise.all([
      tx.roomType.findMany({ where: { propertyId }, select: { id: true, name: true, active: true, baseRateMinor: true }, orderBy: { name: "asc" } }),
      tx.reservation.count({ where: { ratePlanId: id } }),
    ]);
    return { plan, types, reservations: used };
  });
}

async function writePlan(tx: Tx, ctx: Ctx, propertyId: string, d: z.output<typeof planSchema>, id?: string) {
  const dup = await tx.ratePlan.findFirst({ where: { propertyId, code: d.code, ...(id && { id: { not: id } }) } });
  if (dup) throw new AppError("CONFLICT", `The code ${d.code} is already used by "${dup.name}".`);
  const types = await tx.roomType.findMany({ where: { propertyId, id: { in: d.rates.map((r) => r.roomTypeId) } } });
  if (types.length !== d.rates.length) throw new AppError("NOT_FOUND", "One of the categories was not found.");
  const inactive = types.find((t) => !t.active);
  if (d.active && inactive) throw new AppError("VALIDATION", `"${inactive.name}" is inactive; remove it from the plan or reactivate it.`);

  const others = (await loadPlans(tx, propertyId)).filter((p) => p.id !== id);
  const candidate: PlanInput = {
    id: id ?? "new", name: d.name, code: d.code, active: d.active, priority: d.priority, validFrom: d.validFrom || null, validTo: d.validTo || null,
    weekendDays: d.weekendDays, minStay: d.minStay ?? null, maxStay: d.maxStay ?? null, createdAt: Date.now(),
    rates: d.rates.map((r) => ({ roomTypeId: r.roomTypeId, weekdayRateMinor: r.weekdayRateMinor, weekendRateMinor: r.weekendRateMinor ?? null, singleOccupancyRateMinor: r.singleOccupancyRateMinor ?? null, extraAdultRateMinor: r.extraAdultRateMinor ?? null, extraChildRateMinor: r.extraChildRateMinor ?? null })),
  };
  const clash = findPlanConflicts(candidate, others);
  if (clash.length) {
    const names = new Map(types.map((t) => [t.id, t.name]));
    const c = clash[0];
    throw new AppError("CONFLICT", `This plan overlaps "${c.otherName}" for ${c.roomTypeIds.map((x) => names.get(x) ?? "a category").join(", ")} on the same dates at the same priority, so it is unclear which one applies. Change the dates, or give one plan a higher priority.`);
  }

  const data = {
    name: d.name, code: d.code, description: d.description || null, active: d.active,
    validFrom: d.validFrom ? toDate(d.validFrom) : null, validTo: d.validTo ? toDate(d.validTo) : null,
    priority: d.priority, weekendDays: d.weekendDays, mealPlan: d.mealPlan, refundable: d.refundable,
    minStay: d.minStay ?? null, maxStay: d.maxStay ?? null, taxNote: d.taxNote || null,
  };
  const plan = id
    ? await tx.ratePlan.update({ where: { id }, data })
    : await tx.ratePlan.create({ data: { ...data, tenantId: ctx.tenantId, propertyId } });
  if (id) await tx.ratePlanRate.deleteMany({ where: { ratePlanId: id } });
  await tx.ratePlanRate.createMany({
    data: d.rates.map((r) => ({
      tenantId: ctx.tenantId, ratePlanId: plan.id, roomTypeId: r.roomTypeId, weekdayRateMinor: r.weekdayRateMinor, weekendRateMinor: r.weekendRateMinor ?? null,
      singleOccupancyRateMinor: r.singleOccupancyRateMinor ?? null, extraAdultRateMinor: r.extraAdultRateMinor ?? null, extraChildRateMinor: r.extraChildRateMinor ?? null,
    })),
  });
  return plan;
}

export async function createRatePlan(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rates.manage");
  const propertyId = requireProperty(ctx);
  const d = planSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const p = await writePlan(tx, ctx, propertyId, d);
    await audit(tx, ctx, { action: "ratePlan.create", entityType: "RatePlan", entityId: p.id, after: { name: p.name, code: p.code, priority: p.priority, from: d.validFrom || null, to: d.validTo || null, lines: d.rates.length } });
    return p;
  });
}

export async function updateRatePlan(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "rates.manage");
  const propertyId = requireProperty(ctx);
  const d = planSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cur = await tx.ratePlan.findFirst({ where: { id, propertyId }, include: { rates: true } });
    if (!cur) throw new AppError("NOT_FOUND", "Rate plan not found.");
    assertFresh(cur.updatedAt, d.expectedUpdatedAt);
    const p = await writePlan(tx, ctx, propertyId, d, id);
    await audit(tx, ctx, {
      action: "ratePlan.update", entityType: "RatePlan", entityId: id,
      before: { name: cur.name, priority: cur.priority, from: iso(cur.validFrom), to: iso(cur.validTo), active: cur.active, weekday: cur.rates.map((r) => r.weekdayRateMinor) },
      after: { name: p.name, priority: p.priority, from: d.validFrom || null, to: d.validTo || null, active: p.active, weekday: d.rates.map((r) => r.weekdayRateMinor) },
      reason: "Existing bookings keep the rates they were booked at.",
    });
    return p;
  });
}

export async function duplicateRatePlan(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rates.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const src = await tx.ratePlan.findFirst({ where: { id, propertyId }, include: { rates: true } });
    if (!src) throw new AppError("NOT_FOUND", "Rate plan not found.");
    let code = `${src.code}-COPY`.slice(0, 20);
    for (let i = 2; await tx.ratePlan.findFirst({ where: { propertyId, code } }); i++) code = `${src.code.slice(0, 14)}-COPY${i}`;
    // The copy starts inactive so it cannot clash with the original until its dates or priority are set.
    const copy = await tx.ratePlan.create({
      data: {
        tenantId: ctx.tenantId, propertyId, name: `Copy of ${src.name}`.slice(0, 80), code, description: src.description, active: false, validFrom: src.validFrom, validTo: src.validTo,
        priority: src.priority, weekendDays: src.weekendDays, mealPlan: src.mealPlan, refundable: src.refundable, minStay: src.minStay, maxStay: src.maxStay, taxNote: src.taxNote,
      },
    });
    await tx.ratePlanRate.createMany({
      data: src.rates.map((r) => ({ tenantId: ctx.tenantId, ratePlanId: copy.id, roomTypeId: r.roomTypeId, weekdayRateMinor: r.weekdayRateMinor, weekendRateMinor: r.weekendRateMinor, singleOccupancyRateMinor: r.singleOccupancyRateMinor, extraAdultRateMinor: r.extraAdultRateMinor, extraChildRateMinor: r.extraChildRateMinor })),
    });
    await audit(tx, ctx, { action: "ratePlan.duplicate", entityType: "RatePlan", entityId: copy.id, after: { from: src.code, code } });
    return copy;
  });
}

export async function setRatePlanActive(db: PrismaClient, ctx: Ctx, id: string, active: boolean) {
  authorize(ctx, "rates.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cur = await tx.ratePlan.findFirst({ where: { id, propertyId }, include: { rates: true } });
    if (!cur) throw new AppError("NOT_FOUND", "Rate plan not found.");
    if (cur.active === active) throw new AppError("CONFLICT", `The plan is already ${active ? "active" : "archived"}.`);
    if (active) {
      const clash = findPlanConflicts({ ...toPlanInput(cur), active: true }, (await loadPlans(tx, propertyId)).filter((p) => p.id !== id));
      if (clash.length) throw new AppError("CONFLICT", `It overlaps "${clash[0].otherName}" at the same priority. Change the dates or priority first.`);
    }
    await tx.ratePlan.update({ where: { id }, data: { active } });
    await audit(tx, ctx, { action: active ? "ratePlan.reactivate" : "ratePlan.archive", entityType: "RatePlan", entityId: id, before: { active: cur.active }, after: { active } });
  });
}

export async function deleteRatePlan(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rates.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cur = await tx.ratePlan.findFirst({ where: { id, propertyId } });
    if (!cur) throw new AppError("NOT_FOUND", "Rate plan not found.");
    const used = await tx.reservation.count({ where: { ratePlanId: id } });
    if (used) throw new AppError("CONFLICT", `"${cur.name}" was used by ${used} reservation${used === 1 ? "" : "s"}, so it cannot be deleted. Archive it; those bookings keep their rates.`);
    await tx.ratePlan.delete({ where: { id } });
    await audit(tx, ctx, { action: "ratePlan.delete", entityType: "RatePlan", entityId: id, before: { name: cur.name, code: cur.code } });
  });
}

export type RatePreviewCell = NightRate;
/** Effective nightly rate by category and date. Read-only; uses the same logic as the booking quote. */
export async function previewRates(db: PrismaClient, ctx: Ctx, input: { from: string; days: number; stayNights?: number; adults?: number }) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  const from = day.parse(input.from);
  const days = Math.min(31, Math.max(1, input.days));
  const stay = Math.max(1, input.stayNights ?? 1);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [types, plans] = await Promise.all([
      tx.roomType.findMany({ where: { propertyId, active: true }, orderBy: { name: "asc" } }),
      loadPlans(tx, propertyId),
    ]);
    const dates = Array.from({ length: days }, (_, i) => new Date(toDate(from).getTime() + i * 86_400_000).toISOString().slice(0, 10));
    const rows = types.map((t) => ({
      type: { id: t.id, name: t.name, baseRateMinor: t.baseRateMinor },
      // Each date is priced as the first night of a stay of `stay` nights, so minimum-stay plans can be previewed.
      nights: dates.map((date) => effectiveNightRates({ roomTypeId: t.id, baseRateMinor: t.baseRateMinor, dates: [date, ...Array.from({ length: stay - 1 }, () => date)], adults: input.adults ?? 2, children: 0, plans })[0]),
    }));
    return { dates, rows };
  });
}

// ---------------------------------------------------------------- property profile

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter the hotel name.").max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,12}$/, "Property code: 2 to 12 letters, digits, - or _.").optional().or(z.literal("")),
  address: z.string().trim().max(300).optional(),
  operationalAddress: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(30).regex(/^[0-9+()\-\s]*$/, "Phone can contain digits, spaces, + ( ) and -.").optional(),
  email: z.string().trim().max(200).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address.").optional(),
  timezone: z.string().trim().min(3).max(60),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency is a 3-letter code such as INR."),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM."),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM."),
  description: z.string().trim().max(1000).optional(),
  amenities: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
  logoUrl: z.string().trim().max(300).refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "The logo link must start with https://").optional(),
  imageUrls: z.array(z.string().trim().max(300).regex(/^https:\/\/[^\s]+$/i, "Image links must start with https://")).max(10).default([]),
  expectedUpdatedAt: z.string().optional(),
});

export async function updatePropertyProfile(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "settings.manage");
  const propertyId = requireProperty(ctx);
  const d = profileSchema.parse(input);
  try { new Intl.DateTimeFormat("en", { timeZone: d.timezone }); } catch { throw new AppError("VALIDATION", "Unknown timezone."); }
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cur = await tx.property.findFirstOrThrow({ where: { id: propertyId } });
    assertFresh(cur.updatedAt, d.expectedUpdatedAt);
    if (d.code) {
      const dup = await tx.property.findFirst({ where: { tenantId: ctx.tenantId, code: { equals: d.code, mode: "insensitive" }, id: { not: propertyId } } });
      if (dup) throw new AppError("CONFLICT", `The code ${d.code} is already used by "${dup.name}".`);
    }
    const { expectedUpdatedAt: _e, code, address, operationalAddress, phone, email, description, logoUrl, ...rest } = d;
    void _e;
    const p = await tx.property.update({
      where: { id: propertyId },
      data: { ...rest, code: code || null, address: address || null, operationalAddress: operationalAddress || null, phone: phone || null, email: email || null, description: description || null, logoUrl: logoUrl || null },
    });
    await audit(tx, ctx, {
      action: "property.profile", entityType: "Property", entityId: propertyId,
      before: { name: cur.name, code: cur.code, phone: cur.phone, email: cur.email, timezone: cur.timezone, currency: cur.currency },
      after: { name: p.name, code: p.code, phone: p.phone, email: p.email, timezone: p.timezone, currency: p.currency },
    });
    return p;
  });
}

export async function setPropertyStatus(db: PrismaClient, ctx: Ctx, status: "ACTIVE" | "INACTIVE" | "ARCHIVED", reason: string) {
  authorize(ctx, "settings.manage");
  if (!ALL_PROPERTY_ROLES.includes(ctx.role) && status !== "ACTIVE") throw new AppError("FORBIDDEN", "Only an owner, group admin or general manager can deactivate a property.");
  const propertyId = requireProperty(ctx);
  z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).parse(status);
  if (status !== "ACTIVE" && reason.trim().length < 3) throw new AppError("VALIDATION", "Give a reason.");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const cur = await tx.property.findFirstOrThrow({ where: { id: propertyId } });
    if (cur.status === status) throw new AppError("CONFLICT", `The property is already ${status.toLowerCase()}.`);
    if (status !== "ACTIVE") {
      const t = await today(tx, propertyId);
      const live = await tx.reservation.count({ where: { propertyId, status: { in: ["TENTATIVE", "CONFIRMED", "CHECKED_IN"] }, departure: { gte: toDate(t) } } });
      if (live) throw new AppError("CONFLICT", `${live} reservation${live === 1 ? " is" : "s are"} still current or upcoming. Move or cancel them before deactivating the property.`);
    }
    await tx.property.update({ where: { id: propertyId }, data: { status } });
    await audit(tx, ctx, { action: "property.status", entityType: "Property", entityId: propertyId, before: { status: cur.status }, after: { status }, reason: reason.trim() || undefined });
  });
}

/** Permanent deletion is only possible for a property that was never used. */
export async function deleteProperty(db: PrismaClient, ctx: Ctx, propertyId: string) {
  authorize(ctx, "settings.manage");
  if (!ALL_PROPERTY_ROLES.includes(ctx.role)) throw new AppError("FORBIDDEN", "Only an owner, group admin or general manager can delete a property.");
  uuid.parse(propertyId);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const p = await tx.property.findFirst({ where: { id: propertyId } });
    if (!p) throw new AppError("NOT_FOUND", "Property not found.");
    const [res, folios, invoices, rooms, shifts, tasks, users] = await Promise.all([
      tx.reservation.count({ where: { propertyId } }), tx.folio.count({ where: { propertyId } }), tx.invoice.count({ where: { propertyId } }),
      tx.room.count({ where: { propertyId } }), tx.cashShift.count({ where: { propertyId } }), tx.housekeepingTask.count({ where: { propertyId } }), tx.userProperty.count({ where: { propertyId } }),
    ]);
    const why = [res && `${res} reservations`, folios && `${folios} folios`, invoices && `${invoices} invoices`, rooms && `${rooms} rooms`, shifts && `${shifts} cash shifts`, tasks && `${tasks} housekeeping tasks`, users && `${users} staff assignments`].filter(Boolean);
    if (why.length) throw new AppError("CONFLICT", `"${p.name}" cannot be deleted because it has ${why.join(", ")}. Deactivate or archive it instead; its records are kept.`);
    const others = await tx.property.count({ where: { tenantId: ctx.tenantId, id: { not: propertyId } } });
    if (!others) throw new AppError("CONFLICT", "A business must keep at least one property.");
    await tx.property.delete({ where: { id: propertyId } });
    await audit(tx, { ...ctx, propertyId: null }, { action: "property.delete", entityType: "Property", entityId: propertyId, before: { name: p.name } });
  });
}
