import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { audit } from "./audit";
import { loadSettings } from "./settings";

const HK = ["DIRTY", "CLEANING", "CLEAN", "INSPECTED"] as const;

export async function setRoomStatus(db: PrismaClient, ctx: Ctx, roomId: string, status: (typeof HK)[number]) {
  authorize(ctx, "housekeeping.update");
  const propertyId = requireProperty(ctx);
  z.enum(HK).parse(status);
  // Inspection is a supervisory sign-off.
  if (status === "INSPECTED") authorize(ctx, "housekeeping.manage");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: roomId, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    await tx.room.update({ where: { id: room.id }, data: { housekeeping: status } });
    await tx.roomStatusHistory.create({
      data: { tenantId: ctx.tenantId, propertyId, roomId: room.id, kind: "HOUSEKEEPING", fromState: room.housekeeping, toState: status, changedBy: ctx.userId },
    });
    // Keep the room's open cleaning tasks in step, following the hotel's inspection policy.
    const inspect = (await loadSettings(tx, ctx.tenantId, propertyId))["housekeeping.inspectionRequired"];
    const bump = { version: { increment: 1 }, updatedBy: ctx.userId, updatedAt: new Date() };
    if (status === "CLEANING") {
      await tx.housekeepingTask.updateMany({ where: { roomId: room.id, status: "PENDING" }, data: { status: "IN_PROGRESS", startedAt: new Date(), ...bump } });
    } else if (status === "CLEAN") {
      await tx.housekeepingTask.updateMany({ where: { roomId: room.id, status: { in: ["PENDING", "IN_PROGRESS"] } }, data: inspect ? { status: "AWAITING_INSPECTION", inspectionRequestedAt: new Date(), ...bump } : { status: "DONE", doneAt: new Date(), ...bump } });
    } else if (status === "INSPECTED") {
      await tx.housekeepingTask.updateMany({ where: { roomId: room.id, status: { in: ["PENDING", "IN_PROGRESS", "AWAITING_INSPECTION"] } }, data: { status: "INSPECTED", doneAt: new Date(), inspectionResult: "PASSED", inspectedBy: ctx.userId, inspectedAt: new Date(), ...bump } });
    } else if (status === "DIRTY") {
      await tx.housekeepingTask.updateMany({ where: { roomId: room.id, status: { in: ["IN_PROGRESS", "AWAITING_INSPECTION"] } }, data: { status: "PENDING", ...bump } });
    }
    await audit(tx, ctx, {
      action: "room.housekeeping",
      entityType: "Room",
      entityId: room.id,
      before: { status: room.housekeeping },
      after: { status },
    });
  });
}

export async function createMaintenanceRequest(
  db: PrismaClient,
  ctx: Ctx,
  input: { roomId: string; title: string; blocksRoom?: boolean },
) {
  authorize(ctx, "maintenance.manage");
  const propertyId = requireProperty(ctx);
  const d = z
    .object({
      roomId: z.string().uuid(),
      title: z.string().trim().min(2).max(200),
      blocksRoom: z.boolean().default(false),
    })
    .parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: d.roomId, propertyId } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    const m = await tx.maintenanceRequest.create({ data: { ...d, tenantId: ctx.tenantId, propertyId } });
    await audit(tx, ctx, { action: "maintenance.create", entityType: "MaintenanceRequest", entityId: m.id, after: d });
    return m;
  });
}

export async function listHousekeeping(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "housekeeping.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.room.findMany({ where: { propertyId, active: true }, include: { roomType: true }, orderBy: { number: "asc" } }),
  );
}
