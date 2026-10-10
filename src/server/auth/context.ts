import type { PrismaClient } from "@prisma/client";
import { AppError } from "@/server/errors";
import { assertPermission, type Permission, type RoleKey } from "./permissions";

export type Ctx = {
  userId: string;
  tenantId: string;
  role: RoleKey;
  extra: Permission[];
  /** Currently selected property; always validated against the user's accessible properties. */
  propertyId: string | null;
  accessiblePropertyIds: string[];
  requestId: string;
  mfaEnabled: boolean;
  emailVerified: boolean;
};

const ALL_PROPERTY_ROLES: RoleKey[] = ["HOTEL_OWNER", "GROUP_ADMIN", "GENERAL_MANAGER"];

/**
 * Builds the request context from server-validated facts only:
 * the user must be active, the session epoch must match (revocation), and the
 * membership must be active. The tenant is derived from the membership, never
 * from client input.
 */
export async function loadContext(
  db: PrismaClient,
  session: { userId: string; epoch: number },
  wantedPropertyId?: string | null,
): Promise<Ctx> {
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.active || user.sessionEpoch !== session.epoch) {
    throw new AppError("UNAUTHENTICATED", "Please sign in again.");
  }
  const membership = await db.membership.findFirst({
    where: { userId: user.id, active: true },
    include: { properties: true },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) throw new AppError("FORBIDDEN", "You do not belong to any hotel account.");

  const role = membership.role as RoleKey;
  const props = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${membership.tenantId}, true)`;
    return tx.property.findMany({ where: { tenantId: membership.tenantId }, select: { id: true } });
  });
  const accessible = ALL_PROPERTY_ROLES.includes(role)
    ? props.map((p) => p.id)
    : membership.properties.map((p) => p.propertyId).filter((id) => props.some((x) => x.id === id));

  const propertyId =
    wantedPropertyId && accessible.includes(wantedPropertyId) ? wantedPropertyId : (accessible[0] ?? null);

  return {
    userId: user.id,
    tenantId: membership.tenantId,
    role,
    extra: membership.extraPermissions as Permission[],
    propertyId,
    accessiblePropertyIds: accessible,
    requestId: crypto.randomUUID(),
    mfaEnabled: user.mfaEnabled,
    emailVerified: !!user.emailVerifiedAt,
  };
}

export function authorize(ctx: Ctx, permission: Permission): void {
  assertPermission(ctx.role, permission, ctx.extra);
}

export function requireProperty(ctx: Ctx): string {
  if (!ctx.propertyId) throw new AppError("VALIDATION", "Select or create a property first.");
  return ctx.propertyId;
}
