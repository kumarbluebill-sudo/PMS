import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { audit } from "./audit";

const name = z.string().trim().min(1, "Enter a name.").max(80);

export async function listStructure(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const buildings = await tx.building.findMany({
      where: { propertyId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        floors: { orderBy: [{ sortOrder: "asc" }, { level: "asc" }], include: { _count: { select: { rooms: true } } } },
        _count: { select: { rooms: true } },
      },
    });
    return buildings;
  });
}

export async function createBuilding(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z.object({ name }).parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (await tx.building.findFirst({ where: { propertyId, name: d.name } })) {
      throw new AppError("CONFLICT", `A building called "${d.name}" already exists.`);
    }
    const max = await tx.building.aggregate({ where: { propertyId }, _max: { sortOrder: true } });
    const b = await tx.building.create({ data: { tenantId: ctx.tenantId, propertyId, name: d.name, sortOrder: (max._max.sortOrder ?? -1) + 1 } });
    await audit(tx, ctx, { action: "building.create", entityType: "Building", entityId: b.id, after: d });
    return b;
  });
}

export async function createFloor(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z
    .object({ buildingId: z.string().uuid(), label: name, level: z.number().int().min(-5).max(200).default(0) })
    .parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const b = await tx.building.findFirst({ where: { id: d.buildingId, propertyId } });
    if (!b) throw new AppError("NOT_FOUND", "Building not found.");
    if (await tx.floor.findFirst({ where: { buildingId: b.id, label: d.label } })) {
      throw new AppError("CONFLICT", `${b.name} already has a floor called "${d.label}".`);
    }
    const f = await tx.floor.create({
      data: { tenantId: ctx.tenantId, propertyId, buildingId: b.id, label: d.label, level: d.level, sortOrder: d.level },
    });
    await audit(tx, ctx, { action: "floor.create", entityType: "Floor", entityId: f.id, after: d });
    return f;
  });
}

/** Deactivates or reactivates. Rows are never deleted so historical bookings keep their room location. */
export async function setBuildingActive(db: PrismaClient, ctx: Ctx, id: string, active: boolean) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const b = await tx.building.findFirst({ where: { id, propertyId } });
    if (!b) throw new AppError("NOT_FOUND", "Building not found.");
    await tx.building.update({ where: { id }, data: { active } });
    await tx.floor.updateMany({ where: { buildingId: id }, data: { active } });
    await audit(tx, ctx, { action: active ? "building.activate" : "building.deactivate", entityType: "Building", entityId: id, before: { active: b.active }, after: { active } });
  });
}

export async function setFloorActive(db: PrismaClient, ctx: Ctx, id: string, active: boolean) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const f = await tx.floor.findFirst({ where: { id, propertyId } });
    if (!f) throw new AppError("NOT_FOUND", "Floor not found.");
    await tx.floor.update({ where: { id }, data: { active } });
    await audit(tx, ctx, { action: active ? "floor.activate" : "floor.deactivate", entityType: "Floor", entityId: id, before: { active: f.active }, after: { active } });
  });
}

/** Moves a building or floor one step up or down in display order. */
export async function reorder(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z.object({ kind: z.enum(["building", "floor"]), id: z.string().uuid(), direction: z.enum(["up", "down"]) }).parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows =
      d.kind === "building"
        ? await tx.building.findMany({ where: { propertyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })
        : await (async () => {
            const f = await tx.floor.findFirst({ where: { id: d.id, propertyId } });
            if (!f) throw new AppError("NOT_FOUND", "Floor not found.");
            return tx.floor.findMany({ where: { buildingId: f.buildingId }, orderBy: [{ sortOrder: "asc" }, { level: "asc" }] });
          })();
    const i = rows.findIndex((r) => r.id === d.id);
    if (i < 0) throw new AppError("NOT_FOUND", "Item not found.");
    const j = d.direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    const order = rows.map((r) => r.id);
    [order[i], order[j]] = [order[j], order[i]];
    for (let n = 0; n < order.length; n++) {
      if (d.kind === "building") await tx.building.update({ where: { id: order[n] }, data: { sortOrder: n } });
      else await tx.floor.update({ where: { id: order[n] }, data: { sortOrder: n } });
    }
    await audit(tx, ctx, { action: `${d.kind}.reorder`, entityType: d.kind === "building" ? "Building" : "Floor", entityId: d.id, after: { direction: d.direction } });
  });
}

/** Assigns a room to a floor (and its building). Keeps the legacy numeric floor in sync. */
export async function assignRoomFloor(db: PrismaClient, ctx: Ctx, roomId: string, floorId: string | null) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: roomId, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    let data: { floorId: string | null; buildingId: string | null; floor: number | null; layoutX: null; layoutY: null };
    if (floorId) {
      const f = await tx.floor.findFirst({ where: { id: floorId, propertyId } });
      if (!f) throw new AppError("NOT_FOUND", "Floor not found.");
      if (!f.active) throw new AppError("VALIDATION", "That floor is inactive.");
      data = { floorId: f.id, buildingId: f.buildingId, floor: f.level, layoutX: null, layoutY: null };
    } else {
      data = { floorId: null, buildingId: null, floor: null, layoutX: null, layoutY: null };
    }
    await tx.room.update({ where: { id: room.id }, data });
    await audit(tx, ctx, { action: "room.assignFloor", entityType: "Room", entityId: room.id, before: { floorId: room.floorId }, after: { floorId } });
  });
}

export const GRID_COLS = 12;
export const GRID_ROWS = 8;

export async function getFloorPlan(db: PrismaClient, ctx: Ctx, floorId: string) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const floor = await tx.floor.findFirst({ where: { id: floorId, propertyId }, include: { building: true } });
    if (!floor) throw new AppError("NOT_FOUND", "Floor not found.");
    const rooms = await tx.room.findMany({
      where: { propertyId, floorId },
      include: { roomType: { select: { name: true } } },
      orderBy: { number: "asc" },
    });
    return { floor, rooms };
  });
}

/** Places a room on its floor's grid, or removes it from the plan when x/y are null. One room per cell. */
export async function placeRoom(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z
    .object({
      roomId: z.string().uuid(),
      x: z.number().int().min(0).max(GRID_COLS - 1).nullable(),
      y: z.number().int().min(0).max(GRID_ROWS - 1).nullable(),
    })
    .refine((v) => (v.x === null) === (v.y === null), "Set both column and row.")
    .parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: d.roomId, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    if (!room.floorId) throw new AppError("VALIDATION", "Assign the room to a floor first.");
    if (d.x !== null) {
      const clash = await tx.room.findFirst({ where: { floorId: room.floorId, layoutX: d.x, layoutY: d.y, id: { not: room.id } } });
      if (clash) throw new AppError("CONFLICT", `Room ${clash.number} is already in that cell.`);
    }
    await tx.room.update({ where: { id: room.id }, data: { layoutX: d.x, layoutY: d.y } });
    await audit(tx, ctx, { action: "room.place", entityType: "Room", entityId: room.id, before: { x: room.layoutX, y: room.layoutY }, after: { x: d.x, y: d.y } });
  });
}
