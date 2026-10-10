import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, type Ctx } from "@/server/auth/context";

export async function audit(
  tx: Prisma.TransactionClient,
  ctx: Pick<Ctx, "tenantId" | "userId" | "requestId" | "propertyId">,
  e: {
    action: string;
    entityType: string;
    entityId?: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    reason?: string;
  },
) {
  await tx.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      actorId: ctx.userId,
      requestId: ctx.requestId,
      ...e,
    },
  });
}

/** audit_logs carries no RLS, so the tenant filter here is the isolation boundary. */
export async function listAuditLogs(db: PrismaClient, ctx: Ctx, filter: { action?: string } = {}) {
  authorize(ctx, "audit.view");
  return db.auditLog.findMany({
    where: { tenantId: ctx.tenantId, ...(filter.action && { action: { contains: filter.action } }) },
    orderBy: { at: "desc" },
    take: 200,
  });
}
