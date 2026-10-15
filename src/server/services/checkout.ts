import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { stayNights } from "@/server/domain/stay";
import { audit } from "./audit";
import { folioBalance, postRoomNightsTx } from "./billing";
import { issueInvoice, previewInvoice } from "./invoicing";
import { METHODS, recordPayment } from "./payments";
import { checkOut } from "./reservations";

const iso = (d: Date) => d.toISOString().slice(0, 10);

const inputSchema = z.object({
  payment: z
    .object({
      method: z.enum(METHODS),
      amountMinor: z.number().int().positive(),
      reference: z.string().trim().max(100).optional(),
      idempotencyKey: z.string().min(8).max(100),
    })
    .optional(),
  /** What to do if a balance is still due after any payment. Both need manager authority and a reason. */
  exception: z
    .object({
      kind: z.enum(["COMPANY_CREDIT", "APPROVED_UNPAID"]),
      reason: z.string().trim().min(3, "Give a reason for the exception.").max(300),
      company: z.string().trim().max(150).optional(),
    })
    .optional(),
  issueInvoice: z.boolean().default(true),
  recipient: z.object({ name: z.string().trim().min(1).max(150), gstin: z.string().optional(), address: z.string().optional() }).optional(),
});
export type SettleInput = z.input<typeof inputSchema>;

/** What the checkout page shows before anything is changed. */
export async function checkoutOverview(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "frontdesk.checkout");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId }, include: { guest: { select: { name: true } } } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const folio = await tx.folio.findUnique({ where: { reservationId_label: { reservationId, label: "GUEST" } } });
    const posted = folio
      ? await tx.folioEntry.count({ where: { folioId: folio.id, idempotencyKey: { startsWith: `room:${reservationId}:` } } })
      : 0;
    const nights = stayNights(iso(r.arrival), iso(r.departure)).length;
    return { reservation: r, folioId: folio?.id ?? null, unpostedNights: Math.max(0, nights - posted) };
  });
}

/**
 * The checkout sequence: post unposted room nights, check the final invoice can be produced, take any payment,
 * handle a remaining balance only through a manager-approved exception, issue the final invoice, and only then
 * mark the stay checked out (which leaves the room dirty, never clean).
 */
export async function settleAndCheckOut(db: PrismaClient, ctx: Ctx, reservationId: string, input: unknown) {
  authorize(ctx, "frontdesk.checkout");
  const propertyId = requireProperty(ctx);
  const d = inputSchema.parse(input);
  // An exception is a manager decision: refuse it before any charge is posted or invoice issued.
  if (d.exception) authorize(ctx, "billing.waive");

  const res = await withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    if (r.status !== "CHECKED_IN") throw new AppError("CONFLICT", "Only an in-house guest can be checked out.");
    const posted = await postRoomNightsTx(tx, ctx, reservationId);
    return { folioId: posted.folioId };
  });
  const folioId = res.folioId;

  // Find out now whether the final invoice can be produced, before any money is taken.
  let wantInvoice = d.issueInvoice;
  if (wantInvoice) {
    try {
      await previewInvoice(db, ctx, folioId, { recipient: d.recipient });
    } catch (e) {
      if (e instanceof AppError && /no uninvoiced charges/i.test(e.message)) wantInvoice = false;
      else throw e;
    }
  }

  if (d.payment) {
    // Never take more than is owed: an overpayment would have to be refunded, so refuse it before any money is recorded.
    const owed = await withTenant(db, ctx.tenantId, (tx) => folioBalance(tx, folioId));
    if (d.payment.amountMinor > owed) throw new AppError("VALIDATION", `The payment is more than the balance due (₹${(Math.max(owed, 0) / 100).toFixed(2)}).`);
    await recordPayment(db, ctx, folioId, d.payment);
  }

  let balance = await withTenant(db, ctx.tenantId, (tx) => folioBalance(tx, folioId));
  let waiveReason: string | undefined;
  if (balance > 0) {
    if (!d.exception) {
      throw new AppError("CONFLICT", `There is an outstanding balance of ₹${(balance / 100).toFixed(2)}. Collect payment, or ask a manager to approve an exception.`);
    }
    if (d.exception.kind === "COMPANY_CREDIT") {
      await recordPayment(db, ctx, folioId, {
        method: "COMPANY_CREDIT", amountMinor: balance, reference: d.exception.company || undefined, idempotencyKey: `checkout-credit:${reservationId}:${balance}`,
      });
      balance = 0;
      await withTenant(db, ctx.tenantId, (tx) =>
        audit(tx, ctx, { action: "checkout.company_credit", entityType: "Reservation", entityId: reservationId, after: { company: d.exception!.company ?? null }, reason: d.exception!.reason }),
      );
    } else {
      waiveReason = d.exception.reason;
    }
  }

  let invoiceId: string | undefined;
  if (wantInvoice) invoiceId = (await issueInvoice(db, ctx, folioId, { recipient: d.recipient })).id;

  await checkOut(db, ctx, reservationId, { waiveReason });
  return { invoiceId, balanceMinor: balance };
}

