import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { audit } from "./audit";

const roomTypeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  maxAdults: z.number().int().min(1).max(20).default(2),
  maxChildren: z.number().int().min(0).max(20).default(0),
  baseRateMinor: z.number().int().min(0).default(0),
  baseOccupancy: z.number().int().min(1).max(20).default(2),
  extraAdultRateMinor: z.number().int().min(0).default(0),
  extraChildRateMinor: z.number().int().min(0).default(0),
});

export async function createRoomType(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = roomTypeSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rt = await tx.roomType.create({ data: { ...d, tenantId: ctx.tenantId, propertyId } });
    await audit(tx, ctx, { action: "roomType.create", entityType: "RoomType", entityId: rt.id, after: d });
    return rt;
  });
}

export async function createRoom(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const d = z
    .object({ roomTypeId: z.string().uuid(), number: z.string().trim().min(1).max(20), floor: z.number().int().min(-5).max(200).optional() })
    .parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rt = await tx.roomType.findFirst({ where: { id: d.roomTypeId, propertyId } });
    if (!rt) throw new AppError("NOT_FOUND", "Room type not found.");
    const dup = await tx.room.findFirst({ where: { propertyId, number: d.number } });
    if (dup) throw new AppError("CONFLICT", `Room ${d.number} already exists.`);
    const room = await tx.room.create({ data: { ...d, tenantId: ctx.tenantId, propertyId } });
    await audit(tx, ctx, { action: "room.create", entityType: "Room", entityId: room.id, after: d });
    return room;
  });
}

export async function setRoomFloor(db: PrismaClient, ctx: Ctx, roomId: string, floor: number | null) {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const f = z.number().int().min(-5).max(200).nullable().parse(floor);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: roomId, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    await tx.room.update({ where: { id: room.id }, data: { floor: f } });
    await audit(tx, ctx, { action: "room.floor", entityType: "Room", entityId: room.id, before: { floor: room.floor }, after: { floor: f } });
  });
}

export async function listRoomTypes(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.roomType.findMany({ where: { propertyId }, orderBy: { name: "asc" } }),
  );
}

export async function listRooms(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.room.findMany({ where: { propertyId }, include: { roomType: true }, orderBy: { number: "asc" } }),
  );
}
