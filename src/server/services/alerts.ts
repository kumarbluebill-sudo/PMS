import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { sortAlerts, type Alert } from "@/server/domain/kpi";
import { formatInr } from "@/server/money";
import { audit } from "./audit";
import { complaintAlerts } from "./feedback";
import { operations, type Operations } from "./frontoffice";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/** The manager view is for people who can approve exceptions and read the audit trail. */
export const isManagerView = (ctx: Pick<Ctx, "role" | "extra">) =>
  roleHasPermission(ctx.role, "audit.view", ctx.extra) && roleHasPermission(ctx.role, "rooms.approve", ctx.extra);

/**
 * Alerts are computed live from current data, so they can never be stale or invented. Only an acknowledgement or
 * resolution is stored (AlertAck), keyed by a stable kind+entity key.
 */
export async function listAlerts(db: PrismaClient, ctx: Ctx, opts: { includeResolved?: boolean; ops?: Operations } = {}): Promise<Alert[]> {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(ctx.role, p, ctx.extra);
  const ops = opts.ops ?? (await operations(db, ctx));
  const alerts: Alert[] = [];
  const add = (a: Alert) => alerts.push(a);
  const link = (id: string) => `/app/reservations/${id}`;

  for (const o of ops.overdueDepartures) add({ key: `overdue:${o.id}`, kind: "OVERDUE_CHECKOUT", severity: "CRITICAL", title: `Overdue checkout: ${o.guest}`, detail: `${o.room ? `Room ${o.room}, ` : ""}was due out ${o.departure} (${o.reference}).`, href: link(o.id) });
  for (const o of ops.conflicts) add({ key: `conflict:${o.id}`, kind: "ALLOCATION_CONFLICT", severity: "CRITICAL", title: `Room allocation conflict: ${o.guest}`, detail: `${o.conflict} (${o.reference}, arrives ${o.arrival}).`, href: `/app/check-in/${o.id}` });
  for (const o of ops.unassigned) add({ key: `unassigned:${o.id}`, kind: "NO_ROOM", severity: o.arrival <= ops.today ? "CRITICAL" : "WARNING", title: `No room allocated: ${o.guest}`, detail: `Arrives ${o.arrival} (${o.reference}).`, href: `/app/check-in/${o.id}` });
  for (const o of ops.incompleteRegistration.filter((x) => x.arrival <= ops.today)) add({ key: `missing:${o.id}`, kind: "MISSING_INFO", severity: "WARNING", title: `Missing information: ${o.guest}`, detail: `${o.issues.filter((i) => i !== "Registration not completed").join(", ") || "Registration not completed"} (${o.reference}).`, href: `/app/check-in/${o.id}` });
  for (const o of ops.departuresExpected.filter((x) => (x.balanceMinor ?? 0) > 0)) add({ key: `balance:${o.id}`, kind: "OUTSTANDING_BALANCE", severity: "WARNING", title: `Balance due at checkout: ${o.guest}`, detail: `${formatInr(o.balanceMinor ?? 0)} outstanding${o.room ? `, room ${o.room}` : ""}.`, href: `/app/check-out/${o.id}` });
  for (const o of ops.noShowCandidates) add({ key: `noshow:${o.id}`, kind: "NO_SHOW_REVIEW", severity: "WARNING", title: `No-show to review: ${o.guest}`, detail: `Arrival ${o.arrival} has passed the review time ${ops.noShowCutoff} (${o.reference}).`, href: `/app/operations#no-shows` });
  for (const o of ops.toConfirm.filter((x) => x.arrival <= iso(new Date(Date.now() + 2 * DAY_MS)))) add({ key: `confirm:${o.id}`, kind: "NEEDS_CONFIRMATION", severity: "INFO", title: `Reservation needs confirmation: ${o.guest}`, detail: `${o.reference}, arrives ${o.arrival}.`, href: link(o.id) });

  await withTenant(db, ctx.tenantId, async (tx) => {
    const blocks = await tx.maintenanceRequest.findMany({
      where: { propertyId, status: { not: "RESOLVED" } },
      include: { room: { select: { number: true } } },
    });
    const now = Date.now();
    for (const b of blocks) {
      if (b.blocksRoom) add({ key: `ooo:${b.id}`, kind: "OUT_OF_ORDER", severity: "INFO", title: `Room ${b.room.number} blocked`, detail: b.title, href: `/app/maintenance/${b.id}` });
      if (now - b.createdAt.getTime() > 3 * DAY_MS) add({ key: `maint:${b.id}`, kind: "UNRESOLVED_MAINTENANCE", severity: "WARNING", title: `Maintenance open for 3+ days: room ${b.room.number}`, detail: b.title, href: `/app/maintenance/${b.id}` });
      if (b.approvalRequired && !b.approvedBy && can("rooms.approve")) add({ key: `approve-block:${b.id}`, kind: "PENDING_APPROVAL", severity: "WARNING", title: `Approval needed: room ${b.room.number} block`, detail: b.title, href: `/app/maintenance/${b.id}` });
    }
    if (can("tax.approve")) {
      const drafts = await tx.taxRule.count({ where: { status: "DRAFT" } });
      if (drafts > 0) add({ key: "approve-tax", kind: "PENDING_APPROVAL", severity: "WARNING", title: `${drafts} tax rule${drafts === 1 ? "" : "s"} awaiting approval`, detail: "A second person must approve draft GST rules.", href: "/app/settings/tax" });
    }
    if (can("cashier.approve")) {
      const shifts = await tx.cashShift.count({ where: { propertyId, status: "CLOSED", approvedBy: null } });
      if (shifts > 0) add({ key: "approve-shifts", kind: "PENDING_APPROVAL", severity: "WARNING", title: `${shifts} closed cash shift${shifts === 1 ? "" : "s"} awaiting approval`, detail: "Review the counted cash and approve.", href: "/app/cashier" });
    }
    if (can("guests.view")) {
      const failed = await tx.messageLog.findMany({ where: { propertyId, status: "FAILED", createdAt: { gte: new Date(now - 7 * DAY_MS) } }, orderBy: { createdAt: "desc" }, take: 20 });
      for (const m of failed) add({ key: `msg:${m.id}`, kind: "FAILED_NOTIFICATION", severity: "WARNING", title: "Guest message failed", detail: `${m.templateKey.replaceAll("_", " ")} to ${m.toMasked}${m.error ? `: ${m.error}` : ""}`, href: "/app/messages" });
    }
    if (can("billing.view") && can("audit.view")) {
      const adj = await tx.folioEntry.findMany({ where: { propertyId, kind: { in: ["DISCOUNT", "REVERSAL"] }, postedAt: { gte: new Date(now - DAY_MS) } }, orderBy: { postedAt: "desc" }, take: 20 });
      for (const e of adj) add({ key: `adj:${e.id}`, kind: "BILLING_ADJUSTMENT", severity: "INFO", title: `${e.kind === "DISCOUNT" ? "Discount" : "Reversal"} posted: ${formatInr(Math.abs(e.netMinor))}`, detail: e.reason ? `Reason: ${e.reason}` : e.description, href: `/app/guest-folios/${e.folioId}` });
    }
  });

  if (can("feedback.view")) {
    const fb = await complaintAlerts(db, ctx);
    if (fb.open > 0) add({ key: "feedback-low", kind: "GUEST_COMPLAINT", severity: "WARNING", title: `${fb.open} low-rating guest complaint${fb.open === 1 ? "" : "s"} need follow-up`, detail: "Review the feedback and add a follow-up note.", href: "/app/feedback?rating=low" });
  }

  // Attach acknowledgements; resolved alerts are hidden unless asked for.
  const acks = await withTenant(db, ctx.tenantId, (tx) => tx.alertAck.findMany({ where: { propertyId, alertKey: { in: alerts.map((a) => a.key) } } }));
  const who = new Map((await db.user.findMany({ where: { id: { in: acks.map((a) => a.by) }, memberships: { some: { tenantId: ctx.tenantId } } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  for (const a of alerts) {
    const k = acks.find((x) => x.alertKey === a.key);
    if (k) a.ack = { status: k.status as "ACKNOWLEDGED" | "RESOLVED", by: who.get(k.by) ?? "Staff", at: k.at.toISOString(), note: k.note };
  }
  return sortAlerts(alerts.filter((a) => opts.includeResolved || a.ack?.status !== "RESOLVED"));
}

export async function setAlertState(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "reservations.modify");
  const propertyId = requireProperty(ctx);
  const d = z.object({ key: z.string().min(3).max(120), status: z.enum(["ACKNOWLEDGED", "RESOLVED", "OPEN"]), note: z.string().trim().max(300).optional() }).parse(input);
  if (d.status === "RESOLVED" && !d.note) throw new AppError("VALIDATION", "Add a note saying how it was resolved.");
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (d.status === "OPEN") {
      await tx.alertAck.deleteMany({ where: { propertyId, alertKey: d.key } });
    } else {
      await tx.alertAck.upsert({
        where: { propertyId_alertKey: { propertyId, alertKey: d.key } },
        create: { tenantId: ctx.tenantId, propertyId, alertKey: d.key, status: d.status, note: d.note ?? null, by: ctx.userId },
        update: { status: d.status, note: d.note ?? null, by: ctx.userId, at: new Date() },
      });
    }
    await audit(tx, ctx, { action: `alert.${d.status.toLowerCase()}`, entityType: "Alert", entityId: undefined, after: { key: d.key }, reason: d.note });
  });
}

/** Counts for the header bell. Acknowledged alerts no longer count as new. */
export async function alertCounts(db: PrismaClient, ctx: Ctx) {
  const all = await listAlerts(db, ctx);
  const open = all.filter((a) => !a.ack);
  return { critical: open.filter((a) => a.severity === "CRITICAL").length, warning: open.filter((a) => a.severity === "WARNING").length, total: open.length };
}

/** Manager-only: who did what today, from the audit trail. */
export async function staffActivity(db: PrismaClient, ctx: Ctx) {
  if (!isManagerView(ctx)) throw new AppError("FORBIDDEN", "This view is for managers.");
  const since = new Date(Date.now() - DAY_MS);
  const rows = await db.auditLog.groupBy({
    by: ["actorId"], where: { tenantId: ctx.tenantId, at: { gte: since }, actorId: { not: null } }, _count: { _all: true }, orderBy: { _count: { actorId: "desc" } }, take: 10,
  });
  const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.actorId!).filter(Boolean) }, memberships: { some: { tenantId: ctx.tenantId } } }, select: { id: true, name: true } });
  return rows.map((r) => ({ name: users.find((u) => u.id === r.actorId)?.name ?? "Staff", actions: r._count._all }));
}
