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

export const AUDIT_PAGE_SIZE = 50;
export type AuditFilter = { action?: string; entityType?: string; entityId?: string; from?: string; to?: string; page?: number };

/** Filtered, paged audit trail for managers, with the name of whoever acted. Read-only; the log itself is append-only. */
export async function searchAuditLogs(db: PrismaClient, ctx: Ctx, f: AuditFilter = {}) {
  authorize(ctx, "audit.view");
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const at = {
    ...(f.from && day.test(f.from) && { gte: new Date(`${f.from}T00:00:00.000Z`) }),
    ...(f.to && day.test(f.to) && { lt: new Date(new Date(`${f.to}T00:00:00.000Z`).getTime() + 86_400_000) }),
  };
  const where = {
    tenantId: ctx.tenantId,
    ...(f.action?.trim() && { action: { contains: f.action.trim() } }),
    ...(f.entityType?.trim() && { entityType: f.entityType.trim() }),
    ...(f.entityId?.trim() && /^[0-9a-f-]{36}$/i.test(f.entityId.trim()) && { entityId: f.entityId.trim() }),
    ...(Object.keys(at).length && { at }),
  };
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const [rows, total, types] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: { at: "desc" }, skip: (page - 1) * AUDIT_PAGE_SIZE, take: AUDIT_PAGE_SIZE }),
    db.auditLog.count({ where }),
    db.auditLog.findMany({ where: { tenantId: ctx.tenantId }, distinct: ["entityType"], select: { entityType: true }, orderBy: { entityType: "asc" } }),
  ]);
  const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const who = new Map(users.map((u) => [u.id, u.name]));
  return {
    rows: rows.map((r) => ({ ...r, actor: r.actorId ? (who.get(r.actorId) ?? "Unknown user") : "System" })),
    total, page, pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)), entityTypes: types.map((t) => t.entityType),
  };
}
