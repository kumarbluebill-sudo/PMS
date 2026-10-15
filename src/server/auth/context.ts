import type { PrismaClient } from "@prisma/client";
import { AppError } from "@/server/errors";
import { assertPermission, READ_ONLY_SAFE, type Permission, type RoleKey } from "./permissions";
import { isReadOnly, type SubStatus } from "@/server/domain/subscription";

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
  /** The hotel's subscription has lapsed: viewing and exporting work, changes are refused. */
  readOnly?: boolean;
  subscriptionStatus?: SubStatus;
};

export const ALL_PROPERTY_ROLES: RoleKey[] = ["HOTEL_OWNER", "GROUP_ADMIN", "GENERAL_MANAGER"];

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
  const { props, sub, pastDueReadOnly } = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${membership.tenantId}, true)`;
    const props = await tx.property.findMany({ where: { tenantId: membership.tenantId }, select: { id: true } });
    const sub = await tx.subscription.findUnique({ where: { tenantId: membership.tenantId }, select: { status: true } });
    const flag = sub ? await tx.platformSetting.findUnique({ where: { key: "saas.pastDueReadOnly" } }) : null;
    return { props, sub, pastDueReadOnly: flag?.value === true };
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
    ...(sub && { subscriptionStatus: sub.status as SubStatus, readOnly: isReadOnly(sub.status as SubStatus, { pastDueReadOnly }) }),
  };
}

export function authorize(ctx: Ctx, permission: Permission): void {
  assertPermission(ctx.role, permission, ctx.extra);
  // One place enforces read-only mode: every service calls authorize, so a lapsed account cannot change anything.
  if (ctx.readOnly && !READ_ONLY_SAFE.test(permission)) {
    throw new AppError("READ_ONLY", "Your subscription is not active, so this account is read-only. You can still view and export your data. Open Subscription & Plans to renew.");
  }
}

export function requireProperty(ctx: Ctx): string {
  if (!ctx.propertyId) throw new AppError("VALIDATION", "Select or create a property first.");
  return ctx.propertyId;
}
