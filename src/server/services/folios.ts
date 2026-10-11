import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { dateInZone } from "@/server/domain/roomStatus";
import type { TaxResult } from "@/server/domain/gst";
import { audit } from "./audit";
import { chargeJournal, ensureFolio, lockFolio, postJournal, reverseEntryTx } from "./billing";

/** Opens (or renames) the company folio of a reservation, so some charges can be billed to a company or agent. */
export async function createCompanyFolio(db: PrismaClient, ctx: Ctx, reservationId: string, input: { billTo: string }) {
  authorize(ctx, "billing.post");
  requireProperty(ctx);
  const billTo = z.string().trim().min(2, "Enter the company or agent name.").max(150).parse(input.billTo);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const folio = await ensureFolio(tx, ctx, reservationId, "COMPANY", billTo);
    if (folio.billTo !== billTo) {
      await tx.folio.update({ where: { id: folio.id }, data: { billTo } });
      await audit(tx, ctx, { action: "folio.company_rename", entityType: "Folio", entityId: folio.id, before: { billTo: folio.billTo }, after: { billTo } });
    } else if (folio.createdAt.getTime() > Date.now() - 5000) {
      await audit(tx, ctx, { action: "folio.company_open", entityType: "Folio", entityId: folio.id, after: { reservationId, billTo } });
    }
    return { ...folio, billTo };
  });
}

/**
 * Moves un-invoiced charges from one folio of a reservation to another (for example room charges to the company).
 * The original entry is reversed and the same amounts are posted on the target, so history stays intact and the
 * stored tax breakdown is carried over unchanged. Needs manager authority and a reason.
 */
export async function transferEntries(
  db: PrismaClient,
  ctx: Ctx,
  fromFolioId: string,
  toFolioId: string,
  entryIds: string[],
  reason: string,
) {
  authorize(ctx, "billing.waive");
  requireProperty(ctx);
  const why = z.string().trim().min(3, "Give a reason for the transfer.").max(300).parse(reason);
  if (fromFolioId === toFolioId) throw new AppError("VALIDATION", "Choose a different folio to move the charges to.");
  const ids = z.array(z.string().uuid()).min(1, "Select at least one charge.").max(200).parse(entryIds);
  return withTenant(db, ctx.tenantId, async (tx) => {
    // Lock in a fixed order so two transfers in opposite directions cannot deadlock.
    const locked = new Map<string, Awaited<ReturnType<typeof lockFolio>>>();
    for (const id of [fromFolioId, toFolioId].sort()) locked.set(id, await lockFolio(tx, ctx, id));
    const from = locked.get(fromFolioId)!;
    const to = locked.get(toFolioId)!;
    if (from.reservationId !== to.reservationId) throw new AppError("VALIDATION", "Charges can only move between folios of the same reservation.");
    if (from.status !== "OPEN" || to.status !== "OPEN") throw new AppError("CONFLICT", "Both folios must be open.");

    const entries = await tx.folioEntry.findMany({ where: { id: { in: ids }, folioId: fromFolioId, kind: "CHARGE", line: null } });
    if (entries.length !== ids.length) throw new AppError("CONFLICT", "Some charges were already invoiced, moved or do not belong to that folio.");
    if (await tx.folioEntry.count({ where: { reversesEntryId: { in: ids } } })) throw new AppError("CONFLICT", "Some charges were already reversed.");

    const property = await tx.property.findUniqueOrThrow({ where: { id: from.propertyId }, select: { timezone: true } });
    const date = dateInZone(new Date(), property.timezone);
    const targetName = to.label === "COMPANY" ? (to.billTo ?? "company folio") : "guest folio";
    for (const e of entries) {
      await reverseEntryTx(tx, ctx, e, { description: `Moved to ${targetName}: ${e.description}`, reason: why, date });
      const moved = await tx.folioEntry.create({
        data: {
          tenantId: ctx.tenantId, propertyId: e.propertyId, folioId: toFolioId, kind: "CHARGE", category: e.category, subCategory: e.subCategory,
          description: e.description, quantity: e.quantity, netMinor: e.netMinor, taxMinor: e.taxMinor, balanceDeltaMinor: e.balanceDeltaMinor,
          taxInclusive: e.taxInclusive, taxDetail: e.taxDetail ?? undefined, taxRuleId: e.taxRuleId, serviceDate: e.serviceDate,
          reason: `Moved from ${from.label === "COMPANY" ? "company folio" : "guest folio"}: ${why}`, postedBy: ctx.userId,
        },
      });
      await postJournal(tx, ctx, {
        date, memo: `Moved charge ${e.description}`.slice(0, 120), sourceType: "FOLIO_ENTRY", sourceId: moved.id,
        lines: chargeJournal(e.category, e.taxDetail as unknown as TaxResult["detail"], e.netMinor, e.balanceDeltaMinor),
      });
    }
    await audit(tx, ctx, {
      action: "folio.transfer", entityType: "Folio", entityId: fromFolioId, reason: why,
      after: { toFolioId, entries: ids, grossMinor: entries.reduce((t, e) => t + e.balanceDeltaMinor, 0) },
    });
    return { moved: entries.length };
  });
}
