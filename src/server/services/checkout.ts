import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { stayNights } from "@/server/domain/stay";
import { audit } from "./audit";
import { folioBalance, postRoomNightsTx } from "./billing";
import { issueInvoiceTx, previewInvoice } from "./invoicing";
import { authorizePayment, METHODS, paymentSchema, recordPaymentTx } from "./payments";
import { checkOutTx } from "./reservations";

type Tx = Prisma.TransactionClient;
const iso = (d: Date) => d.toISOString().slice(0, 10);

const paymentLine = z.object({
  method: z.enum(METHODS),
  amountMinor: z.number().int().positive(),
  reference: z.string().trim().max(100).optional(),
  idempotencyKey: z.string().min(8).max(100),
});

const inputSchema = z.object({
  /** Up to three payments (split tender). Each carries its own key, so a resubmitted form never double-charges. */
  payments: z.array(paymentLine).max(3).default([]),
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
  /** The staff member's explicit confirmation that the guest is leaving and the bill is settled. */
  confirmed: z.literal(true, { message: "Confirm the checkout before completing it." }),
});
export type CheckoutInput = z.input<typeof inputSchema>;

/** Why a checkout cannot finish yet: charges that are not posted, or billing left on another folio. */
export async function checkoutBlockers(tx: Tx, reservationId: string) {
  const r = await tx.reservation.findFirstOrThrow({ where: { id: reservationId } });
  const guestFolio = await tx.folio.findUnique({ where: { reservationId_label: { reservationId, label: "GUEST" } } });
  const posted = guestFolio ? await tx.folioEntry.count({ where: { folioId: guestFolio.id, idempotencyKey: { startsWith: `room:${reservationId}:` } } }) : 0;
  const nights = stayNights(iso(r.arrival), iso(r.departure)).length;
  const company = await tx.folio.findMany({ where: { reservationId, label: "COMPANY" } });
  const companyOpen: { id: string; billTo: string | null; uninvoicedMinor: number }[] = [];
  for (const f of company) {
    const entries = await tx.folioEntry.findMany({ where: { folioId: f.id, kind: { in: ["CHARGE", "DISCOUNT"] }, line: null }, select: { id: true, balanceDeltaMinor: true, reversesEntryId: true } });
    const reversed = new Set((await tx.folioEntry.findMany({ where: { folioId: f.id, reversesEntryId: { not: null } }, select: { reversesEntryId: true } })).map((e) => e.reversesEntryId));
    const sum = entries.filter((e) => !reversed.has(e.id)).reduce((t, e) => t + e.balanceDeltaMinor, 0);
    if (sum > 0) companyOpen.push({ id: f.id, billTo: f.billTo, uninvoicedMinor: sum });
  }
  return { unpostedNights: Math.max(0, nights - posted), companyOpen };
}

/** What the checkout page shows before anything is changed. */
export async function checkoutOverview(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "frontdesk.checkout");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId }, include: { guest: { select: { name: true } } } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const folio = await tx.folio.findUnique({ where: { reservationId_label: { reservationId, label: "GUEST" } } });
    const blockers = await checkoutBlockers(tx, reservationId);
    const assignment = await tx.roomAssignment.findFirst({ where: { reservationId, active: true }, include: { room: { select: { number: true } } } });
    const lastRoom = assignment ?? (await tx.roomAssignment.findFirst({ where: { reservationId }, orderBy: { createdAt: "desc" }, include: { room: { select: { number: true } } } }));
    const checkedIn = await tx.reservationStatusHistory.findFirst({ where: { reservationId, toStatus: "CHECKED_IN" }, orderBy: { changedAt: "asc" }, select: { changedAt: true } });
    return { reservation: r, folioId: folio?.id ?? null, unpostedNights: blockers.unpostedNights, companyOpen: blockers.companyOpen, roomNumber: lastRoom?.room.number ?? null, checkedInAt: checkedIn?.changedAt ?? null };
  });
}

export type CheckoutResult = {
  invoiceId?: string;
  balanceMinor: number;
  paymentIds: string[];
  /** True when this was a repeat of a checkout that had already completed; nothing was changed. */
  alreadyCheckedOut: boolean;
};

/**
 * The whole checkout in one database transaction: lock the reservation, post the remaining nights, refuse if charges
 * are left unposted or billed elsewhere, take the payments, settle or except any balance, issue the invoice, then mark
 * the stay checked out and hand the room to housekeeping. If any step fails, none of it is saved: no payment without a
 * checkout, no invoice without a checkout. Submitting the same checkout twice returns the first result.
 */
export async function completeCheckout(db: PrismaClient, ctx: Ctx, reservationId: string, input: unknown): Promise<CheckoutResult> {
  authorize(ctx, "frontdesk.checkout");
  requireProperty(ctx);
  const d = inputSchema.parse(input);
  for (const p of d.payments) authorizePayment(ctx, paymentSchema.parse(p));
  // An exception is a manager decision: refuse it before anything is posted.
  if (d.exception) {
    authorize(ctx, "billing.waive");
    if (d.exception.kind === "COMPANY_CREDIT") authorizePayment(ctx, paymentSchema.parse({ method: "COMPANY_CREDIT", amountMinor: 1, reference: d.exception.company, idempotencyKey: "company-check" }));
  }
  if (d.issueInvoice) authorize(ctx, "invoices.issue");

  return withTenant(db, ctx.tenantId, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM reservations WHERE id = ${reservationId}::uuid AND "propertyId" = ${ctx.propertyId!}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new AppError("NOT_FOUND", "Reservation not found.");
    if (locked[0].status === "CHECKED_OUT") {
      const folio = await tx.folio.findUnique({ where: { reservationId_label: { reservationId, label: "GUEST" } } });
      const inv = folio ? await tx.invoice.findFirst({ where: { folioId: folio.id }, orderBy: { issuedAt: "desc" }, select: { id: true } }) : null;
      return { invoiceId: inv?.id, balanceMinor: folio ? await folioBalance(tx, folio.id) : 0, paymentIds: [], alreadyCheckedOut: true };
    }
    if (locked[0].status !== "CHECKED_IN") throw new AppError("CONFLICT", "Only an in-house guest can be checked out.");

    const { folioId } = await postRoomNightsTx(tx, ctx, reservationId);
    const blockers = await checkoutBlockers(tx, reservationId);
    if (blockers.unpostedNights > 0) throw new AppError("CONFLICT", `${blockers.unpostedNights} room night(s) could not be posted to the folio. Post them from the folio, then try again.`);
    if (blockers.companyOpen.length > 0) {
      const c = blockers.companyOpen[0];
      throw new AppError("CONFLICT", `The company folio${c.billTo ? ` for ${c.billTo}` : ""} still has ₹${(c.uninvoicedMinor / 100).toFixed(2)} of charges that are not invoiced. Invoice or move them before checking out.`);
    }

    // Never take more than is owed: an overpayment would have to be refunded.
    const owed = await folioBalance(tx, folioId);
    const total = d.payments.reduce((t, p) => t + p.amountMinor, 0);
    if (total > Math.max(owed, 0)) throw new AppError("VALIDATION", `The payments (₹${(total / 100).toFixed(2)}) are more than the balance due (₹${(Math.max(owed, 0) / 100).toFixed(2)}).`);
    const paymentIds: string[] = [];
    for (const p of d.payments) paymentIds.push((await recordPaymentTx(tx, ctx, folioId, paymentSchema.parse(p))).payment.id);

    let balance = await folioBalance(tx, folioId);
    let waiveReason: string | undefined;
    if (balance > 0) {
      if (!d.exception) throw new AppError("CONFLICT", `There is an outstanding balance of ₹${(balance / 100).toFixed(2)}. Collect payment, or ask a manager to approve an exception.`);
      if (d.exception.kind === "COMPANY_CREDIT") {
        const credit = await recordPaymentTx(tx, ctx, folioId, paymentSchema.parse({ method: "COMPANY_CREDIT", amountMinor: balance, reference: d.exception.company || undefined, idempotencyKey: `checkout-credit:${reservationId}:${balance}` }));
        paymentIds.push(credit.payment.id);
        balance = 0;
        await audit(tx, ctx, { action: "checkout.company_credit", entityType: "Reservation", entityId: reservationId, after: { company: d.exception.company ?? null }, reason: d.exception.reason });
      } else waiveReason = d.exception.reason;
    }

    let invoiceId: string | undefined;
    if (d.issueInvoice) {
      try {
        invoiceId = (await issueInvoiceTx(tx, ctx, folioId, { recipient: d.recipient })).id;
      } catch (e) {
        // Nothing left to invoice (already invoiced from the folio) is fine; any other failure aborts the checkout.
        if (!(e instanceof AppError && /no uninvoiced charges/i.test(e.message))) throw e;
      }
    }

    await checkOutTx(tx, ctx, reservationId, { waiveReason });
    return { invoiceId, balanceMinor: balance, paymentIds, alreadyCheckedOut: false };
  });
}

const legacySchema = z.object({
  payment: paymentLine.optional(),
  exception: z.object({ kind: z.enum(["COMPANY_CREDIT", "APPROVED_UNPAID"]), reason: z.string().trim().min(3, "Give a reason for the exception.").max(300), company: z.string().trim().max(150).optional() }).optional(),
  issueInvoice: z.boolean().default(true),
  recipient: z.object({ name: z.string().trim().min(1).max(150), gstin: z.string().optional(), address: z.string().optional() }).optional(),
});
export type SettleInput = z.input<typeof legacySchema>;

/** Single-payment form of the checkout. Kept for existing callers; it runs the same single transaction. */
export async function settleAndCheckOut(db: PrismaClient, ctx: Ctx, reservationId: string, input: unknown) {
  const d = legacySchema.parse(input);
  // Find out first whether the final invoice can be produced, so a problem is reported before any money is taken.
  if (d.issueInvoice) {
    try {
      await previewInvoice(db, ctx, (await checkoutOverview(db, ctx, reservationId)).folioId ?? "", { recipient: d.recipient });
    } catch (e) {
      if (!(e instanceof AppError && /no uninvoiced charges|not found/i.test(e.message))) throw e;
    }
  }
  const r = await completeCheckout(db, ctx, reservationId, { payments: d.payment ? [d.payment] : [], exception: d.exception, issueInvoice: d.issueInvoice, recipient: d.recipient, confirmed: true });
  return { invoiceId: r.invoiceId, balanceMinor: r.balanceMinor };
}
