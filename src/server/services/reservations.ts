import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { roleHasPermission } from "@/server/auth/permissions";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { blockCoversDate } from "@/server/domain/roomBlock";
import { assertTransition, nightsBetween, type ReservationStatus } from "@/server/domain/stay";
import { audit } from "./audit";
import { findFreeRooms, toDate } from "./availability";
import { folioBalance, postRoomNightsTx } from "./billing";
import { checklistTx } from "./confirmation";
import { notifyTx } from "./notifications";


export async function searchAvailability(
  db: PrismaClient,
  ctx: Ctx,
  input: { roomTypeId: string; arrival: string; departure: string },
) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  nightsBetween(input.arrival, input.departure);
  return withTenant(db, ctx.tenantId, (tx) =>
    findFreeRooms(tx, propertyId, input.roomTypeId, input.arrival, input.departure),
  );
}

/** The status change itself, inside the caller's transaction, with its history row and audit entry. */
async function transitionTx(
  tx: Prisma.TransactionClient,
  ctx: Ctx,
  reservationId: string,
  to: ReservationStatus,
  extra?: (tx: Prisma.TransactionClient, r: { id: string; propertyId: string }) => Promise<void>,
  reason?: string,
  patch: Prisma.ReservationUncheckedUpdateInput = {},
) {
  const propertyId = requireProperty(ctx);
  const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId } });
  if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
  const from = r.status as ReservationStatus;
  assertTransition(from, to);
  await tx.reservation.update({ where: { id: r.id }, data: { status: to, ...patch } });
  await tx.reservationStatusHistory.create({
    data: { tenantId: ctx.tenantId, reservationId: r.id, fromStatus: from, toStatus: to, changedBy: ctx.userId, reason: reason?.trim() || null },
  });
  if (extra) await extra(tx, r);
  await audit(tx, ctx, {
    action: `reservation.${to.toLowerCase()}`,
    entityType: "Reservation",
    entityId: r.id,
    before: { status: from },
    after: { status: to },
    reason,
  });
  return { id: r.id, status: to };
}

async function transition(
  db: PrismaClient,
  ctx: Ctx,
  reservationId: string,
  to: ReservationStatus,
  extra?: (tx: Prisma.TransactionClient, r: { id: string; propertyId: string }) => Promise<void>,
  reason?: string,
) {
  requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) => transitionTx(tx, ctx, reservationId, to, extra, reason));
}

const releaseRoom = async (tx: Prisma.TransactionClient, r: { id: string }) => {
  await tx.roomAssignment.updateMany({ where: { reservationId: r.id }, data: { active: false } });
};

export async function cancelReservation(db: PrismaClient, ctx: Ctx, id: string, reason: string) {
  authorize(ctx, "reservations.cancel");
  if (!reason.trim()) throw new AppError("VALIDATION", "A cancellation reason is required.");
  return transition(db, ctx, id, "CANCELLED", releaseRoom, reason);
}

export async function confirmReservation(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "reservations.modify");
  requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    // A held booking is confirmed only once the checklist has no blockers (a room held, valid dates and guests, an open category).
    const { blockers } = await checklistTx(tx, ctx, id);
    if (blockers.length) throw new AppError("VALIDATION", `Cannot confirm yet: ${blockers.map((b) => b.detail).join(" ")}`);
    return transitionTx(tx, ctx, id, "CONFIRMED");
  });
}

export async function markNoShow(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "reservations.cancel");
  return transition(db, ctx, id, "NO_SHOW", async (tx, r) => {
    await releaseRoom(tx, r);
    await tx.reservation.update({ where: { id: r.id }, data: { noShowAt: new Date() } });
  });
}

export async function checkIn(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "frontdesk.checkin");
  return transition(db, ctx, id, "CHECKED_IN", async (tx, r) => {
    const a = await tx.roomAssignment.findFirst({
      where: { reservationId: r.id, active: true },
      include: { room: true },
    });
    if (!a) throw new AppError("CONFLICT", "No room is assigned to this reservation.");
    if (a.room.outOfOrder) throw new AppError("CONFLICT", `Room ${a.room.number} is out of order.`);
    const today = new Date().toISOString().slice(0, 10);
    const blocks = await tx.maintenanceRequest.findMany({
      where: { roomId: a.roomId, blocksRoom: true, status: { not: "RESOLVED" } },
      select: { startDate: true, expectedResolution: true, title: true },
    });
    const live = blocks.find((b) =>
      blockCoversDate(
        { startDate: b.startDate ? b.startDate.toISOString().slice(0, 10) : null, expectedResolution: b.expectedResolution ? b.expectedResolution.toISOString().slice(0, 10) : null },
        today,
      ),
    );
    if (live) throw new AppError("CONFLICT", `Room ${a.room.number} is blocked for maintenance: ${live.title}.`);
    if (a.room.housekeeping !== "CLEAN" && a.room.housekeeping !== "INSPECTED") {
      throw new AppError("CONFLICT", `Room ${a.room.number} is not ready (${a.room.housekeeping.toLowerCase()}).`);
    }
  });
}

/**
 * Completes a stay inside the caller's transaction: posts any remaining room nights, refuses while a balance is
 * still owed (unless a manager waived it with a reason), records when and by whom the guest left, releases the room,
 * leaves it Vacant Dirty, creates the departure housekeeping task and notifies housekeeping. Everything here commits
 * or rolls back together with the caller's other billing steps.
 */
export async function checkOutTx(tx: Prisma.TransactionClient, ctx: Ctx, id: string, opts: { waiveReason?: string } = {}) {
  const departedAt = new Date();
  return transitionTx(tx, ctx, id, "CHECKED_OUT", async (t, r) => {
    const { folioId } = await postRoomNightsTx(t, ctx, r.id);
    const balance = await folioBalance(t, folioId);
    if (balance > 0) {
      if (!opts.waiveReason?.trim()) {
        throw new AppError("CONFLICT", `There is an outstanding balance of ₹${(balance / 100).toFixed(2)}. Collect payment, or ask a manager to waive it.`);
      }
      authorize(ctx, "billing.waive");
      await audit(t, ctx, {
        action: "checkout.waive_balance", entityType: "Reservation", entityId: r.id,
        after: { balanceMinor: balance }, reason: opts.waiveReason.trim(),
      });
    }

    const a = await t.roomAssignment.findFirst({ where: { reservationId: r.id, active: true }, include: { room: { select: { number: true, housekeeping: true } } } });
    if (a) {
      await t.roomAssignment.update({ where: { id: a.id }, data: { active: false } });
      await t.room.update({ where: { id: a.roomId }, data: { housekeeping: "DIRTY", dnd: false, dndAt: null } });
      await t.roomStatusHistory.create({
        data: { tenantId: ctx.tenantId, propertyId: r.propertyId, roomId: a.roomId, kind: "HOUSEKEEPING", fromState: a.room.housekeeping, toState: "DIRTY", reason: "Guest checked out", changedBy: ctx.userId },
      });
      await t.housekeepingTask.create({
        data: { tenantId: ctx.tenantId, propertyId: r.propertyId, roomId: a.roomId, kind: "DEPARTURE", reservationId: r.id, updatedBy: ctx.userId },
      });
      await notifyTx(t, ctx, {
        dedupeKey: `checkout:${r.id}`, kind: "ROOM_CHECKED_OUT", title: `Room ${a.room.number} checked out`,
        body: "The room is Vacant Dirty and needs cleaning.", href: "/app/housekeeping?status=dirty", audiencePerm: "housekeeping.view",
      });
    }
  }, undefined, { actualDeparture: departedAt, checkedOutBy: ctx.userId });
}

export async function checkOut(db: PrismaClient, ctx: Ctx, id: string, opts: { waiveReason?: string } = {}) {
  authorize(ctx, "frontdesk.checkout");
  requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) => checkOutTx(tx, ctx, id, opts));
}

export async function listReservations(
  db: PrismaClient,
  ctx: Ctx,
  filter: { status?: ReservationStatus; arrivalOn?: string; departureOn?: string } = {},
) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.reservation.findMany({
      where: {
        propertyId,
        ...(filter.status && { status: filter.status }),
        ...(filter.arrivalOn && { arrival: toDate(filter.arrivalOn) }),
        ...(filter.departureOn && { departure: toDate(filter.departureOn) }),
      },
      include: {
        guest: { select: { id: true, name: true } },
        assignments: { where: { active: true }, include: { room: true } },
      },
      orderBy: { arrival: "asc" },
      take: 200,
    }),
  );
}

export const RESERVATION_SORTS = ["arrival", "departure", "created", "guest"] as const;
export type ReservationListFilter = {
  q?: string; status?: string; roomTypeId?: string; source?: string; roomId?: string;
  arrivalFrom?: string; arrivalTo?: string; departureFrom?: string; departureTo?: string;
  payment?: "UNPAID" | "PARTIAL" | "PAID"; sort?: (typeof RESERVATION_SORTS)[number]; dir?: "asc" | "desc"; page?: number;
};
export const RESERVATION_PAGE_SIZE = 25;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Payment status from the amounts: nothing paid, some paid, or fully covered. */
export function paymentStatus(totalMinor: number, paidMinor: number): "UNPAID" | "PARTIAL" | "PAID" {
  if (paidMinor <= 0) return totalMinor > 0 ? "UNPAID" : "PAID";
  return paidMinor >= totalMinor ? "PAID" : "PARTIAL";
}

/**
 * Filtered, sorted, paged reservation list with the money columns. Money comes from the folio ledger; before room
 * nights are posted (they post at checkout) the booking-time estimate stands in for the total. Money is only
 * returned to users who can view billing.
 */
export async function listReservationsPage(db: PrismaClient, ctx: Ctx, f: ReservationListFilter = {}) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  const canMoney = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  const day = (s?: string) => (s && DAY_RE.test(s) ? toDate(s) : undefined);
  const range = (from?: string, to?: string) => {
    const a = day(from), b = day(to);
    return a || b ? { ...(a && { gte: a }), ...(b && { lte: b }) } : undefined;
  };
  const q = f.q?.trim();
  const where: Prisma.ReservationWhereInput = {
    propertyId,
    ...(f.status && { status: f.status }),
    ...(f.roomTypeId && { roomTypeId: f.roomTypeId }),
    ...(f.source && { source: f.source }),
    ...(f.roomId && { assignments: { some: { roomId: f.roomId, active: true } } }),
    ...(range(f.arrivalFrom, f.arrivalTo) && { arrival: range(f.arrivalFrom, f.arrivalTo) }),
    ...(range(f.departureFrom, f.departureTo) && { departure: range(f.departureFrom, f.departureTo) }),
    ...(q && {
      OR: [
        { reference: { contains: q, mode: "insensitive" } },
        { externalRef: { contains: q, mode: "insensitive" } },
        { guest: { name: { contains: q, mode: "insensitive" } } },
        { guest: { phone: { contains: q.replace(/\s+/g, "") } } },
        { guest: { email: { contains: q, mode: "insensitive" } } },
      ],
    }),
  };
  const dir = f.dir === "desc" ? "desc" : "asc";
  const orderBy: Prisma.ReservationOrderByWithRelationInput[] =
    f.sort === "departure" ? [{ departure: dir }, { reference: "asc" }]
    : f.sort === "created" ? [{ createdAt: dir }]
    : f.sort === "guest" ? [{ guest: { name: dir } }, { arrival: "asc" }]
    : [{ arrival: dir }, { reference: "asc" }];
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const byPayment = !!f.payment && canMoney;

  return withTenant(db, ctx.tenantId, async (tx) => {
    const include = {
      guest: { select: { id: true, name: true, phone: true, email: true } },
      assignments: { where: { active: true }, include: { room: { select: { number: true } } } },
    } as const;
    const total = byPayment ? 0 : await tx.reservation.count({ where });
    const rows = await tx.reservation.findMany({
      where, include, orderBy,
      skip: byPayment ? 0 : (page - 1) * RESERVATION_PAGE_SIZE,
      take: byPayment ? 2000 : RESERVATION_PAGE_SIZE,
    });

    const ids = rows.map((r) => r.id);
    const [types, users, entries] = await Promise.all([
      tx.roomType.findMany({ where: { propertyId }, select: { id: true, name: true } }),
      tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdBy))] } }, select: { id: true, name: true } }),
      canMoney && ids.length
        ? tx.folioEntry.groupBy({ by: ["folioId", "kind"], where: { folio: { reservationId: { in: ids } } }, _sum: { balanceDeltaMinor: true } })
        : Promise.resolve([]),
    ]);
    const folios = canMoney && entries.length
      ? await tx.folio.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.folioId))] } }, select: { id: true, reservationId: true } })
      : [];
    const folioRes = new Map(folios.map((x) => [x.id, x.reservationId]));
    const sums = new Map<string, { posted: number; paid: number; all: number }>();
    for (const e of entries) {
      const rid = folioRes.get(e.folioId);
      if (!rid) continue;
      const s = sums.get(rid) ?? { posted: 0, paid: 0, all: 0 };
      const v = e._sum.balanceDeltaMinor ?? 0;
      s.all += v;
      if (e.kind === "CHARGE" || e.kind === "DISCOUNT" || e.kind === "REVERSAL") s.posted += v;
      else s.paid -= v; // payments are negative, refunds positive
      sums.set(rid, s);
    }
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));

    let items = rows.map((r) => {
      const s = sums.get(r.id) ?? { posted: 0, paid: 0, all: 0 };
      const totalMinor = s.posted > 0 ? s.posted : (r.quotedTotalMinor ?? 0);
      const paidMinor = s.paid;
      const money = canMoney
        ? { totalMinor, paidMinor, balanceMinor: Math.max(0, totalMinor - paidMinor), payment: paymentStatus(totalMinor, paidMinor), estimated: s.posted <= 0 }
        : null;
      return {
        id: r.id, reference: r.reference, externalRef: r.externalRef, status: r.status, source: r.source,
        arrival: r.arrival, departure: r.departure, nights: Math.max(1, Math.round((r.departure.getTime() - r.arrival.getTime()) / 86_400_000)),
        adults: r.adults, children: r.children, vip: r.vip, createdAt: r.createdAt,
        createdBy: userName.get(r.createdBy) ?? "—", roomType: typeName.get(r.roomTypeId) ?? "—",
        room: r.assignments[0]?.room.number ?? null, rateMinor: canMoney ? r.agreedRateMinor : null,
        guest: r.guest, money,
      };
    });
    let count = total;
    if (byPayment) {
      items = items.filter((i) => i.money?.payment === f.payment);
      count = items.length;
      items = items.slice((page - 1) * RESERVATION_PAGE_SIZE, page * RESERVATION_PAGE_SIZE);
    }
    return { items, total: count, page, pages: Math.max(1, Math.ceil(count / RESERVATION_PAGE_SIZE)), pageSize: RESERVATION_PAGE_SIZE, canMoney };
  });
}

export async function getReservation(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({
      where: { id, propertyId },
      include: {
        guest: true,
        assignments: { include: { room: { include: { roomType: true } } }, orderBy: { createdAt: "asc" } },
        history: { orderBy: { changedAt: "asc" } },
      },
    });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    return r;
  });
}

export { createReservation } from "./booking";
export { findFreeRooms };

export type TimelineItem = { at: Date; by: string; what: string; detail?: string; reason?: string | null };

const ACTION_LABELS: Record<string, string> = {
  "reservation.create": "Reservation created", "reservation.change_departure": "Departure date changed", "reservation.move_room": "Room changed",
  "reservation.assign_room": "Room assigned", "reservation.registration": "Registration updated", "reservation.id_verified": "ID verified", "reservation.modify": "Booking changed",
  "reservation.requests": "Requests or VIP updated", "reservation.no_show_confirmed": "No-show confirmed", "checkout.waive_balance": "Balance waived at checkout",
};
const brief = (o: unknown) => {
  if (!o || typeof o !== "object") return undefined;
  const e = Object.entries(o as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object");
  return e.length ? e.map(([k, v]) => `${k}: ${String(v)}`).join(", ") : undefined;
};

/**
 * One timeline of what changed on a reservation and who changed it: status moves, dates, room, requests and, for
 * users who can view billing, payments and refunds. Built from the status history, the audit log and the folio.
 */
export async function reservationTimeline(db: PrismaClient, ctx: Ctx, reservationId: string): Promise<TimelineItem[]> {
  authorize(ctx, "reservations.view");
  const propertyId = requireProperty(ctx);
  const canMoney = roleHasPermission(ctx.role, "billing.view", ctx.extra);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId }, select: { id: true, createdAt: true, createdBy: true } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const [hist, logs, pays] = await Promise.all([
      tx.reservationStatusHistory.findMany({ where: { reservationId }, orderBy: { changedAt: "asc" } }),
      tx.auditLog.findMany({ where: { entityType: "Reservation", entityId: reservationId }, orderBy: { at: "asc" } }),
      canMoney
        ? tx.folioEntry.findMany({ where: { folio: { reservationId }, kind: { in: ["PAYMENT", "REFUND", "DISCOUNT", "REVERSAL"] } }, orderBy: { postedAt: "asc" }, select: { kind: true, balanceDeltaMinor: true, postedAt: true, postedBy: true, reason: true } })
        : Promise.resolve([]),
    ]);
    const ids = [...new Set([...hist.map((h) => h.changedBy), ...logs.map((l) => l.actorId), ...pays.map((p) => p.postedBy)].filter((x): x is string => !!x))];
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const who = new Map(users.map((u) => [u.id, u.name]));
    const name = (id?: string | null) => (id ? who.get(id) ?? "Staff" : "System");
    const items: TimelineItem[] = [
      ...hist.map((h) => ({ at: h.changedAt, by: name(h.changedBy), what: `Status: ${h.fromStatus ? `${h.fromStatus.replace("_", " ").toLowerCase()} → ` : ""}${h.toStatus.replace("_", " ").toLowerCase()}`, reason: h.reason })),
      ...logs
        .filter((l) => !/^reservation\.(confirmed|cancelled|checked_in|checked_out|no_show|tentative)$/.test(l.action))
        .map((l) => ({ at: l.at, by: name(l.actorId), what: ACTION_LABELS[l.action] ?? l.action.replace(/[._]/g, " "), detail: [brief(l.before) && `from ${brief(l.before)}`, brief(l.after) && `to ${brief(l.after)}`].filter(Boolean).join(" ") || undefined, reason: l.reason })),
      ...pays.map((p) => ({
        at: p.postedAt, by: name(p.postedBy),
        what: p.kind === "PAYMENT" ? `Payment received ₹${(-p.balanceDeltaMinor / 100).toFixed(2)}` : p.kind === "REFUND" ? `Refund ₹${(p.balanceDeltaMinor / 100).toFixed(2)}` : p.kind === "DISCOUNT" ? `Discount ₹${(Math.abs(p.balanceDeltaMinor) / 100).toFixed(2)}` : "Charge reversed",
        reason: p.reason,
      })),
    ];
    return items.sort((a, b) => a.at.getTime() - b.at.getTime());
  });
}
