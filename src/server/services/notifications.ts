import type { Prisma, PrismaClient } from "@prisma/client";
import { requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission, type Permission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";

type Tx = Prisma.TransactionClient;

export type NotificationInput = {
  /** Identifies the event. The same key never notifies twice at a property. */
  dedupeKey: string;
  kind: string;
  title: string;
  body?: string;
  href?: string;
  /** Staff holding this permission see the notification. */
  audiencePerm: Permission;
};

/**
 * Records an in-app notification inside the caller's transaction, so it exists exactly when the change it announces
 * was saved. A repeat of the same event is ignored by the unique key (no error, no second notification).
 */
export async function notifyTx(tx: Tx, ctx: Pick<Ctx, "tenantId" | "propertyId">, n: NotificationInput) {
  if (!ctx.propertyId) return;
  await tx.appNotification.createMany({
    data: [{ tenantId: ctx.tenantId, propertyId: ctx.propertyId, dedupeKey: n.dedupeKey, kind: n.kind, title: n.title, body: n.body, href: n.href, audiencePerm: n.audiencePerm }],
    skipDuplicates: true,
  });
}

/** Recent notifications this user may see, newest first, with whether they have read each one. */
export async function listNotifications(db: PrismaClient, ctx: Ctx, opts: { limit?: number; unreadOnly?: boolean } = {}) {
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.appNotification.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" }, take: 200, include: { reads: { where: { userId: ctx.userId }, select: { userId: true } } } });
    const mine = rows
      .filter((r) => roleHasPermission(ctx.role, r.audiencePerm as Permission, ctx.extra))
      .map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, href: r.href, createdAt: r.createdAt, read: r.reads.length > 0 }));
    return (opts.unreadOnly ? mine.filter((m) => !m.read) : mine).slice(0, opts.limit ?? 30);
  });
}

export async function unreadNotificationCount(db: PrismaClient, ctx: Ctx): Promise<number> {
  if (!ctx.propertyId) return 0;
  return (await listNotifications(db, ctx, { unreadOnly: true, limit: 200 })).length;
}

/** Marks the given notifications (or every visible one) as read for this user. Safe to repeat. */
export async function markNotificationsRead(db: PrismaClient, ctx: Ctx, ids?: string[]) {
  const visible = await listNotifications(db, ctx, { unreadOnly: true, limit: 200 });
  const target = (ids ? visible.filter((v) => ids.includes(v.id)) : visible).map((v) => v.id);
  if (!target.length) return 0;
  await withTenant(db, ctx.tenantId, (tx) =>
    tx.notificationRead.createMany({ data: target.map((notificationId) => ({ notificationId, userId: ctx.userId, tenantId: ctx.tenantId })), skipDuplicates: true }),
  );
  return target.length;
}
