import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { audit } from "./audit";
import { ACCOUNT, lockFolio, MAX_AMOUNT_MINOR, paymentAccount, postJournal } from "./billing";

export const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function openShiftFor(tx: Parameters<Parameters<typeof withTenant>[2]>[0], ctx: Ctx) {
  return tx.cashShift.findFirst({ where: { propertyId: ctx.propertyId!, openedBy: ctx.userId, status: "OPEN" } });
}

const paymentSchema = z.object({
  method: z.enum(METHODS),
  amountMinor: z.number().int().positive().max(MAX_AMOUNT_MINOR),
  reference: z.string().trim().max(100).optional(),
  /** Client-generated key so retries and duplicate gateway/webhook deliveries cannot double-post. */
  idempotencyKey: z.string().min(8).max(100),
});

/**
 * Records a payment that staff have confirmed they received (cash in hand, a UPI/card slip, a bank credit).
 * Online-gateway payments will be confirmed server-side by webhook in a later phase; they are never trusted from the browser.
 */
export async function recordPayment(db: PrismaClient, ctx: Ctx, folioId: string, input: unknown) {
  authorize(ctx, "payments.record");
  requireProperty(ctx);
  const d = paymentSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    // Lock first so concurrent deliveries of the same key serialise instead of racing.
    const folio = await lockFolio(tx, ctx, folioId);
    const dup = await tx.payment.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: d.idempotencyKey } });
    if (dup) {
      if (dup.folioId !== folioId || dup.amountMinor !== d.amountMinor) {
        throw new AppError("CONFLICT", "That idempotency key was already used for a different payment.");
      }
      return { payment: dup, duplicate: true };
    }
    if (folio.status !== "OPEN") throw new AppError("CONFLICT", "This folio is closed.");
    // Any payment taken during an open shift is attributed to it; only cash requires one.
    const shift = await openShiftFor(tx, ctx);
    if (d.method === "CASH" && !shift) throw new AppError("CONFLICT", "Open a cash shift before accepting cash.");

    const payment = await tx.payment.create({
      data: {
        tenantId: ctx.tenantId, propertyId: folio.propertyId, folioId, method: d.method, amountMinor: d.amountMinor,
        reference: d.reference, idempotencyKey: d.idempotencyKey, shiftId: shift?.id, receivedBy: ctx.userId,
      },
    });
    await tx.folioEntry.create({
      data: {
        tenantId: ctx.tenantId, propertyId: folio.propertyId, folioId, kind: "PAYMENT", category: "PAYMENT",
        description: `Payment (${d.method})${d.reference ? ` ${d.reference}` : ""}`, balanceDeltaMinor: -d.amountMinor,
        paymentId: payment.id, postedBy: ctx.userId,
      },
    });
    await postJournal(tx, ctx, {
      date: iso(payment.receivedAt), memo: `Payment ${d.method}`, sourceType: "PAYMENT", sourceId: payment.id,
      lines: [{ code: paymentAccount(d.method), debit: d.amountMinor }, { code: ACCOUNT.RECEIVABLE, credit: d.amountMinor }],
    });
    await audit(tx, ctx, {
      action: "payment.record", entityType: "Payment", entityId: payment.id,
      after: { method: d.method, amountMinor: d.amountMinor, folioId },
    });
    return { payment, duplicate: false };
  }).catch(async (e: unknown) => {
    // Two concurrent deliveries with the same key: the loser hits the unique index; return the winner.
    if (e instanceof Error && /Unique constraint|P2002/.test(e.message)) {
      const again = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
        return tx.payment.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: d.idempotencyKey } });
      });
      if (again) return { payment: again, duplicate: true };
    }
    throw e;
  });
}

export async function refundPayment(
  db: PrismaClient,
  ctx: Ctx,
  folioId: string,
  input: { method: (typeof METHODS)[number]; amountMinor: number; reason: string },
) {
  authorize(ctx, "payments.refund");
  requireProperty(ctx);
  const d = z
    .object({ method: z.enum(METHODS), amountMinor: z.number().int().positive().max(MAX_AMOUNT_MINOR), reason: z.string().trim().min(3).max(300) })
    .parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const folio = await lockFolio(tx, ctx, folioId);
    const [paid, refunded] = await Promise.all([
      tx.payment.aggregate({ where: { folioId }, _sum: { amountMinor: true } }),
      tx.refund.aggregate({ where: { folioId }, _sum: { amountMinor: true } }),
    ]);
    const refundable = (paid._sum.amountMinor ?? 0) - (refunded._sum.amountMinor ?? 0);
    if (d.amountMinor > refundable) throw new AppError("VALIDATION", "Refund exceeds the amount paid on this folio.");
    // Money can only leave through a method that actually received money on this folio (prevents laundering via cash).
    const byMethod = await tx.payment.aggregate({ where: { folioId, method: d.method }, _sum: { amountMinor: true } });
    const refundedByMethod = await tx.refund.aggregate({ where: { folioId, method: d.method }, _sum: { amountMinor: true } });
    if (d.amountMinor > (byMethod._sum.amountMinor ?? 0) - (refundedByMethod._sum.amountMinor ?? 0)) {
      throw new AppError("VALIDATION", `Not enough was paid by ${d.method} to refund that amount that way.`);
    }
    const shift = await openShiftFor(tx, ctx);
    if (d.method === "CASH" && !shift) throw new AppError("CONFLICT", "Open a cash shift before paying out cash.");
    const refund = await tx.refund.create({
      data: {
        tenantId: ctx.tenantId, propertyId: folio.propertyId, folioId, method: d.method, amountMinor: d.amountMinor,
        reason: d.reason, shiftId: shift?.id, refundedBy: ctx.userId,
      },
    });
    await tx.folioEntry.create({
      data: {
        tenantId: ctx.tenantId, propertyId: folio.propertyId, folioId, kind: "REFUND", category: "REFUND",
        description: `Refund (${d.method})`, balanceDeltaMinor: d.amountMinor, refundId: refund.id, reason: d.reason,
        postedBy: ctx.userId,
      },
    });
    await postJournal(tx, ctx, {
      date: iso(refund.refundedAt), memo: `Refund ${d.method}`, sourceType: "REFUND", sourceId: refund.id,
      lines: [{ code: ACCOUNT.RECEIVABLE, debit: d.amountMinor }, { code: paymentAccount(d.method), credit: d.amountMinor }],
    });
    await audit(tx, ctx, {
      action: "payment.refund", entityType: "Refund", entityId: refund.id,
      after: { method: d.method, amountMinor: d.amountMinor, folioId }, reason: d.reason,
    });
    return refund;
  });
}

// ---------- cashier shifts ----------

export async function openShift(db: PrismaClient, ctx: Ctx, openingMinor: number) {
  authorize(ctx, "cashier.operate");
  const propertyId = requireProperty(ctx);
  const opening = z.number().int().min(0).max(MAX_AMOUNT_MINOR).parse(openingMinor);
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (await openShiftFor(tx, ctx)) throw new AppError("CONFLICT", "You already have an open shift.");
    const s = await tx.cashShift.create({
      data: { tenantId: ctx.tenantId, propertyId, openedBy: ctx.userId, openingMinor: opening },
    });
    await audit(tx, ctx, { action: "cashier.open", entityType: "CashShift", entityId: s.id, after: { openingMinor: opening } });
    return s;
  });
}

export async function shiftSummary(tx: Parameters<Parameters<typeof withTenant>[2]>[0], shiftId: string) {
  const [pay, ref, shift] = await Promise.all([
    tx.payment.groupBy({ by: ["method"], where: { shiftId }, _sum: { amountMinor: true } }),
    tx.refund.groupBy({ by: ["method"], where: { shiftId }, _sum: { amountMinor: true } }),
    tx.cashShift.findUniqueOrThrow({ where: { id: shiftId } }),
  ]);
  const totals: Record<string, number> = {};
  for (const p of pay) totals[p.method] = (totals[p.method] ?? 0) + (p._sum.amountMinor ?? 0);
  for (const r of ref) totals[r.method] = (totals[r.method] ?? 0) - (r._sum.amountMinor ?? 0);
  const expectedMinor = shift.openingMinor + (totals.CASH ?? 0);
  return { totals, expectedMinor };
}

export async function closeShift(db: PrismaClient, ctx: Ctx, input: { countedMinor: number; varianceReason?: string }) {
  authorize(ctx, "cashier.operate");
  const d = z
    .object({ countedMinor: z.number().int().min(0).max(MAX_AMOUNT_MINOR), varianceReason: z.string().trim().max(300).optional() })
    .parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const shift = await openShiftFor(tx, ctx);
    if (!shift) throw new AppError("NOT_FOUND", "You have no open shift.");
    const { totals, expectedMinor } = await shiftSummary(tx, shift.id);
    const variance = d.countedMinor - expectedMinor;
    if (variance !== 0 && !d.varianceReason) throw new AppError("VALIDATION", "Explain the cash variance before closing the shift.");
    const closed = await tx.cashShift.update({
      where: { id: shift.id },
      data: {
        status: "CLOSED", closedBy: ctx.userId, closedAt: new Date(), countedMinor: d.countedMinor, expectedMinor,
        varianceMinor: variance, totals, varianceReason: d.varianceReason,
      },
    });
    await audit(tx, ctx, {
      action: "cashier.close", entityType: "CashShift", entityId: shift.id,
      after: { expectedMinor, countedMinor: d.countedMinor, varianceMinor: variance }, reason: d.varianceReason,
    });
    return closed;
  });
}

/** A supervisor other than the cashier signs off a closed shift (required when there is a variance). */
export async function approveShift(db: PrismaClient, ctx: Ctx, shiftId: string) {
  authorize(ctx, "cashier.approve");
  requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const s = await tx.cashShift.findFirst({ where: { id: shiftId, propertyId: ctx.propertyId! } });
    if (!s || s.status !== "CLOSED") throw new AppError("NOT_FOUND", "Closed shift not found.");
    if (s.approvedBy) throw new AppError("CONFLICT", "This shift is already approved.");
    if (s.closedBy === ctx.userId) throw new AppError("FORBIDDEN", "A different supervisor must approve your shift.");
    const a = await tx.cashShift.update({ where: { id: s.id }, data: { approvedBy: ctx.userId, approvedAt: new Date() } });
    await audit(tx, ctx, { action: "cashier.approve", entityType: "CashShift", entityId: s.id, after: { varianceMinor: s.varianceMinor } });
    return a;
  });
}

export async function listShifts(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "cashier.operate");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const shifts = await tx.cashShift.findMany({ where: { propertyId }, orderBy: { openedAt: "desc" }, take: 50 });
    const live = await Promise.all(
      shifts.map(async (s) => (s.status === "OPEN" ? { ...s, live: await shiftSummary(tx, s.id) } : { ...s, live: null })),
    );
    return live;
  });
}

export async function listPayments(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "billing.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.payment.findMany({
      where: { propertyId }, orderBy: { receivedAt: "desc" }, take: 100,
      include: { folio: { include: { reservation: { include: { guest: { select: { name: true } } } } } } },
    }),
  );
}
