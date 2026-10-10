import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, type Ctx } from "@/server/auth/context";
import { PERMISSIONS, ROLES, type Permission, type RoleKey } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";
import { assertCanAssign } from "./accounts";

export async function listMembers(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "users.manage");
  const rows = await db.membership.findMany({
    where: { tenantId: ctx.tenantId },
    include: { user: { select: { id: true, name: true, email: true, active: true, mfaEnabled: true } }, properties: true },
    orderBy: { createdAt: "asc" },
  });
  return rows;
}

export async function updateMember(
  db: PrismaClient,
  ctx: Ctx,
  membershipId: string,
  input: { role?: RoleKey; extra?: Permission[]; active?: boolean; propertyIds?: string[] },
) {
  authorize(ctx, "users.manage");
  const d = z
    .object({
      role: z.enum(ROLES).optional(),
      extra: z.array(z.enum(PERMISSIONS)).optional(),
      active: z.boolean().optional(),
      propertyIds: z.array(z.string().uuid()).optional(),
    })
    .parse(input);
  if (d.extra?.length) authorize(ctx, "roles.manage");

  const m = await db.membership.findFirst({ where: { id: membershipId, tenantId: ctx.tenantId } });
  if (!m) throw new AppError("NOT_FOUND", "Member not found.");
  if (m.userId === ctx.userId && (d.active === false || (d.role && d.role !== m.role))) {
    throw new AppError("FORBIDDEN", "You cannot change your own role or deactivate yourself.");
  }
  if (d.role) assertCanAssign(ctx, d.role);
  if (OWNER_LEVEL.includes(m.role as RoleKey) && ctx.role !== "HOTEL_OWNER") {
    throw new AppError("FORBIDDEN", "Only a hotel owner can modify an owner-level member.");
  }
  if (d.propertyIds?.some((id) => !ctx.accessiblePropertyIds.includes(id))) {
    throw new AppError("FORBIDDEN", "You cannot assign access to that property.");
  }
  if (m.role === "HOTEL_OWNER" && (d.active === false || (d.role && d.role !== "HOTEL_OWNER"))) {
    const owners = await db.membership.count({ where: { tenantId: ctx.tenantId, role: "HOTEL_OWNER", active: true } });
    if (owners <= 1) throw new AppError("CONFLICT", "The last active owner cannot be removed.");
  }

  const revoke = d.active === false || (d.role && d.role !== m.role);
  await db.$transaction(async (tx) => {
    await tx.membership.update({
      where: { id: m.id },
      data: { role: d.role, extraPermissions: d.extra, active: d.active },
    });
    if (d.propertyIds) {
      await tx.userProperty.deleteMany({ where: { membershipId: m.id } });
      await tx.userProperty.createMany({ data: d.propertyIds.map((propertyId) => ({ membershipId: m.id, propertyId })) });
    }
    // Immediate session revocation on deactivation or role change.
    if (revoke) await tx.user.update({ where: { id: m.userId }, data: { sessionEpoch: { increment: 1 } } });
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, requestId: ctx.requestId, action: "user.update",
        entityType: "User", entityId: m.userId,
        before: { role: m.role, active: m.active, extra: m.extraPermissions },
        after: { role: d.role ?? m.role, active: d.active ?? m.active, extra: d.extra ?? m.extraPermissions },
      },
    });
  });
}

const OWNER_LEVEL: RoleKey[] = ["HOTEL_OWNER", "GROUP_ADMIN"];
