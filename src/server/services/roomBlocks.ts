import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ALL_PROPERTY_ROLES, authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { dateInZone } from "@/server/domain/roomStatus";
import { blockOverlapsStay, ISSUE_CATEGORIES, ISSUE_MODES, ISSUE_PRIORITIES } from "@/server/domain/roomBlock";
import { audit } from "./audit";
import { notifyTx } from "./notifications";
import { loadSettings } from "./settings";

type Tx = Prisma.TransactionClient;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

const reportSchema = z.object({
  roomId: z.string().uuid(),
  mode: z.enum(ISSUE_MODES),
  category: z.enum(ISSUE_CATEGORIES),
  title: z.string().trim().min(3, "Enter the reason for blocking.").max(200),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(ISSUE_PRIORITIES).default("NORMAL"),
  startDate: day.optional(),
  expectedResolution: day.optional(),
  assignedTo: z.string().uuid().optional(),
  acknowledgeBookings: z.boolean().default(false),
});
export type ReportIssueInput = z.input<typeof reportSchema>;

async function history(
  tx: Tx,
  ctx: Ctx,
  h: { propertyId: string; roomId: string; kind: string; fromState?: string; toState: string; reason?: string; maintenanceId?: string },
) {
  await tx.roomStatusHistory.create({ data: { tenantId: ctx.tenantId, changedBy: ctx.userId, ...h } });
}

/** Today's date in the current property's timezone (used to default form dates). */
export async function propertyToday(db: PrismaClient, ctx: Ctx) {
  const propertyId = requireProperty(ctx);
  const p = await withTenant(db, ctx.tenantId, (tx) => tx.property.findFirstOrThrow({ where: { id: propertyId }, select: { timezone: true } }));
  return dateInZone(new Date(), p.timezone);
}

/** Staff who may be assigned to an issue: active members of this tenant with access to the property. */
export async function listAssignableStaff(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "maintenance.manage");
  const propertyId = requireProperty(ctx);
  const members = await db.membership.findMany({
    where: {
      tenantId: ctx.tenantId, active: true, user: { active: true },
      OR: [{ role: { in: ["MAINTENANCE", "HOTEL_OWNER", "GROUP_ADMIN", "GENERAL_MANAGER", "PROPERTY_MANAGER"] } }],
    },
    include: { user: { select: { id: true, name: true } }, properties: { select: { propertyId: true } } },
  });
  return members
    .filter((m) => ALL_PROPERTY_ROLES.includes(m.role as never) || m.properties.some((p) => p.propertyId === propertyId))
    .map((m) => ({ userId: m.user.id, name: m.user.name, role: m.role }));
}

/**
 * Report a maintenance issue, optionally blocking the room from sale.
 * REPORT only records the issue. MAINTENANCE_BLOCK blocks the room for the start..expected window.
 * OUT_OF_ORDER blocks it immediately and flags the room. Blocking never happens with a guest in the room.
 */
export async function reportIssue(db: PrismaClient, ctx: Ctx, input: unknown) {
  const d = reportSchema.parse(input);
  // Anyone who may report a maintenance issue can raise a plain report; blocking a room needs block authority.
  if (d.mode === "REPORT") { if (!roleHasPermission(ctx.role, "maintenance.report", ctx.extra)) authorize(ctx, "maintenance.manage"); }
  else authorize(ctx, "rooms.block");
  const propertyId = requireProperty(ctx);
  if (d.category === "OTHER" && (d.description?.length ?? 0) < 10) {
    throw new AppError("VALIDATION", "Describe the issue in detail (at least 10 characters) when the category is Other.");
  }
  const blocks = d.mode !== "REPORT";

  return withTenant(db, ctx.tenantId, async (tx) => {
    const room = await tx.room.findFirst({ where: { id: d.roomId, propertyId }, include: { property: { select: { timezone: true } } } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    const today = dateInZone(new Date(), room.property.timezone);
    const start = d.startDate ?? today;
    if (d.expectedResolution && d.expectedResolution < start) {
      throw new AppError("VALIDATION", "The expected resolution date cannot be before the start date.");
    }
    if (d.mode === "OUT_OF_ORDER" && start > today) {
      throw new AppError("VALIDATION", "Out of order takes effect immediately. Use a maintenance block for a future date range.");
    }
    if (d.assignedTo) {
      const m = await tx.membership.findFirst({ where: { tenantId: ctx.tenantId, userId: d.assignedTo, active: true } });
      if (!m) throw new AppError("VALIDATION", "The assigned person is not an active member of this business.");
    }

    let conflictRefs: string[] = [];
    if (blocks) {
      const live = await tx.roomAssignment.findFirst({
        where: { roomId: room.id, active: true, reservation: { status: "CHECKED_IN" } },
        include: { reservation: { select: { reference: true } } },
      });
      if (live && start <= today) {
        throw new AppError("CONFLICT", `Room ${room.number} has a guest in house (${live.reservation.reference}). Move the guest to another room first.`);
      }
      const upcoming = await tx.roomAssignment.findMany({
        where: { roomId: room.id, active: true, reservation: { status: "CONFIRMED" } },
        include: { reservation: { select: { reference: true } } },
      });
      conflictRefs = upcoming
        .filter((a) => blockOverlapsStay({ startDate: start, expectedResolution: d.expectedResolution ?? null }, iso(a.arrival), iso(a.departure)))
        .map((a) => a.reservation.reference);
      if (conflictRefs.length && !d.acknowledgeBookings) {
        throw new AppError(
          "CONFLICT",
          `${conflictRefs.length} booking(s) overlap this block (${conflictRefs.slice(0, 5).join(", ")}). Move them first, or confirm that you will reassign them.`,
        );
      }
    }

    const st = await loadSettings(tx, ctx.tenantId, propertyId);
    if (!(st["rooms.maintenanceCategories"] as readonly string[]).includes(d.category)) {
      throw new AppError("VALIDATION", "That maintenance category is not in use at this property.");
    }
    const approvalRequired = blocks && st["rooms.maintenanceRequireApproval"] && !roleHasPermission(ctx.role, "rooms.approve", ctx.extra);
    const m = await tx.maintenanceRequest.create({
      data: {
        tenantId: ctx.tenantId, propertyId, roomId: room.id,
        title: d.title, description: d.description, category: d.category, priority: d.priority,
        mode: d.mode, blocksRoom: blocks, approvalRequired,
        reportedBy: ctx.userId, startDate: toDate(start),
        expectedResolution: d.expectedResolution ? toDate(d.expectedResolution) : null,
        assignedTo: d.assignedTo,
      },
    });
    if (d.mode === "OUT_OF_ORDER") await tx.room.update({ where: { id: room.id }, data: { outOfOrder: true } });
    if (blocks) {
      await history(tx, ctx, {
        propertyId, roomId: room.id, kind: d.mode,
        fromState: room.outOfOrder ? "OUT_OF_ORDER" : "OPERATIONAL", toState: d.mode === "OUT_OF_ORDER" ? "OUT_OF_ORDER" : "MAINTENANCE",
        reason: `${d.category}: ${d.title}`, maintenanceId: m.id,
      });
    }
    await audit(tx, ctx, {
      action: blocks ? "room.block" : "maintenance.create",
      entityType: "MaintenanceRequest", entityId: m.id,
      after: { room: room.number, mode: d.mode, category: d.category, priority: d.priority, start, expected: d.expectedResolution ?? null, approvalRequired, overlappingBookings: conflictRefs },
      reason: d.title,
    });
    await notifyTx(tx, ctx, {
      dedupeKey: `maint:${m.id}`, kind: blocks ? "ROOM_BLOCKED" : "MAINTENANCE_REPORTED", title: `Room ${room.number}: ${d.title}`,
      body: blocks ? "The room has been taken out of sale." : "Reported for maintenance.", href: "/app/maintenance", audiencePerm: "maintenance.manage",
    });
    return m;
  });
}

/** A second person confirms a block that was raised without approval authority (maker-checker). */
export async function approveBlock(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.approve");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const m = await tx.maintenanceRequest.findFirst({ where: { id, propertyId } });
    if (!m) throw new AppError("NOT_FOUND", "Request not found.");
    if (!m.approvalRequired || m.approvedBy) throw new AppError("CONFLICT", "This request does not need approval.");
    if (m.status === "RESOLVED") throw new AppError("CONFLICT", "This request is already resolved.");
    if (m.reportedBy === ctx.userId) throw new AppError("FORBIDDEN", "Another manager must approve a block you raised.");
    const done = await tx.maintenanceRequest.update({ where: { id }, data: { approvedBy: ctx.userId, approvedAt: new Date() } });
    await history(tx, ctx, { propertyId, roomId: m.roomId, kind: "APPROVED", toState: m.mode === "OUT_OF_ORDER" ? "OUT_OF_ORDER" : "MAINTENANCE", reason: "Block approved", maintenanceId: m.id });
    await audit(tx, ctx, { action: "room.block_approve", entityType: "MaintenanceRequest", entityId: id });
    return done;
  });
}

const resolveSchema = z.object({
  resolutionNote: z.string().trim().min(5, "Record how the issue was resolved.").max(2000),
  confirmReady: z.boolean(),
});

/**
 * Record the resolution. When the last block on a room is lifted the room goes back to "needs cleaning",
 * never straight to sellable; housekeeping must clear it.
 */
export async function resolveIssue(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "rooms.resolve");
  const propertyId = requireProperty(ctx);
  const d = resolveSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const m = await tx.maintenanceRequest.findFirst({ where: { id, propertyId }, include: { room: true } });
    if (!m) throw new AppError("NOT_FOUND", "Request not found.");
    if (m.status === "RESOLVED") throw new AppError("CONFLICT", "This request is already resolved.");
    if (m.blocksRoom && !d.confirmReady) {
      throw new AppError("VALIDATION", "Confirm that the room has been checked and is ready before returning it to service.");
    }
    await tx.maintenanceRequest.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: ctx.userId, resolutionNote: d.resolutionNote },
    });
    let restored = false;
    if (m.blocksRoom) {
      const remaining = await tx.maintenanceRequest.count({
        where: { roomId: m.roomId, blocksRoom: true, status: { not: "RESOLVED" }, id: { not: id } },
      });
      if (remaining === 0) {
        restored = true;
        await tx.room.update({ where: { id: m.roomId }, data: { outOfOrder: false, housekeeping: "DIRTY" } });
        await tx.housekeepingTask.create({ data: { tenantId: ctx.tenantId, propertyId, roomId: m.roomId, kind: "PRIORITY" } });
      }
      await history(tx, ctx, {
        propertyId, roomId: m.roomId, kind: "RESTORED",
        fromState: m.mode === "OUT_OF_ORDER" ? "OUT_OF_ORDER" : "MAINTENANCE",
        toState: restored ? "NEEDS_CLEANING" : "STILL_BLOCKED",
        reason: d.resolutionNote, maintenanceId: m.id,
      });
    }
    await audit(tx, ctx, {
      action: m.blocksRoom ? "room.restore" : "maintenance.resolve",
      entityType: "MaintenanceRequest", entityId: id,
      before: { status: m.status }, after: { status: "RESOLVED", restored }, reason: d.resolutionNote,
    });
    return { id, restored };
  });
}

/** Move an open issue between OPEN and IN_PROGRESS and (re)assign it. */
export async function updateIssue(db: PrismaClient, ctx: Ctx, id: string, input: unknown) {
  authorize(ctx, "maintenance.manage");
  const propertyId = requireProperty(ctx);
  const d = z.object({ status: z.enum(["OPEN", "IN_PROGRESS"]).optional(), assignedTo: z.string().uuid().nullable().optional() }).parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const m = await tx.maintenanceRequest.findFirst({ where: { id, propertyId } });
    if (!m) throw new AppError("NOT_FOUND", "Request not found.");
    if (m.status === "RESOLVED") throw new AppError("CONFLICT", "This request is already resolved.");
    if (d.assignedTo) {
      const mem = await tx.membership.findFirst({ where: { tenantId: ctx.tenantId, userId: d.assignedTo, active: true } });
      if (!mem) throw new AppError("VALIDATION", "The assigned person is not an active member of this business.");
    }
    const done = await tx.maintenanceRequest.update({ where: { id }, data: { ...(d.status && { status: d.status }), ...(d.assignedTo !== undefined && { assignedTo: d.assignedTo }) } });
    await audit(tx, ctx, { action: "maintenance.update", entityType: "MaintenanceRequest", entityId: id, before: { status: m.status, assignedTo: m.assignedTo }, after: d });
    return done;
  });
}

/** The full record for one issue: request, people involved, and the room's status timeline. */
export async function getIssue(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "rooms.view");
  const propertyId = requireProperty(ctx);
  const m = await withTenant(db, ctx.tenantId, async (tx) => {
    const req = await tx.maintenanceRequest.findFirst({ where: { id, propertyId }, include: { room: { include: { roomType: true } } } });
    if (!req) throw new AppError("NOT_FOUND", "Request not found.");
    const timeline = await tx.roomStatusHistory.findMany({ where: { roomId: req.roomId }, orderBy: { changedAt: "desc" }, take: 50 });
    return { req, timeline };
  });
  const ids = [...new Set([m.req.reportedBy, m.req.assignedTo, m.req.approvedBy, m.req.resolvedBy, ...m.timeline.map((t) => t.changedBy)].filter((x): x is string => !!x))];
  const users = await db.user.findMany({ where: { id: { in: ids }, memberships: { some: { tenantId: ctx.tenantId } } }, select: { id: true, name: true } });
  return { ...m, names: new Map(users.map((u) => [u.id, u.name])) };
}
