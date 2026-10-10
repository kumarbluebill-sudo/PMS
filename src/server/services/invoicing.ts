import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { financialYear, GST_STATES, validateGstin, type TaxDetail } from "@/server/domain/gst";
import { audit } from "./audit";
import { lockFolio, postJournal } from "./billing";
import { ACCOUNT } from "./billing";

type Tx = Prisma.TransactionClient;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Today's calendar date in the property's timezone. */
function todayIn(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const recipientSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    gstin: z.string().trim().toUpperCase().optional().or(z.literal("").transform(() => undefined)),
    stateCode: z.string().regex(/^\d{2}$/).optional(),
    address: z.string().trim().max(300).optional(),
  })
  .optional();

type Recipient = { name: string; gstin?: string; stateCode?: string; address?: string };

function resolveRecipient(guest: { name: string; companyName: string | null; gstin: string | null; gstStateCode: string | null }, override?: Recipient): Recipient {
  const r: Recipient = override ?? { name: guest.companyName ?? guest.name, gstin: guest.gstin ?? undefined, stateCode: guest.gstStateCode ?? undefined };
  if (r.gstin) {
    const v = validateGstin(r.gstin);
    if (!v.ok) throw new AppError("VALIDATION", `Recipient ${v.reason}`);
    r.stateCode = v.stateCode;
  } else if (r.stateCode && !GST_STATES[r.stateCode]) {
    throw new AppError("VALIDATION", "Unknown recipient state code.");
  }
  return r;
}

type Totals = { net: number; cgst: number; sgst: number; igst: number; cess: number; gross: number };
const addTotals = (t: Totals, e: { netMinor: number; taxMinor: number; balanceDeltaMinor: number; taxDetail: unknown }): Totals => {
  const d = e.taxDetail as TaxDetail | null;
  return {
    net: t.net + e.netMinor, cgst: t.cgst + (d?.cgstMinor ?? 0), sgst: t.sgst + (d?.sgstMinor ?? 0),
    igst: t.igst + (d?.igstMinor ?? 0), cess: t.cess + (d?.cessMinor ?? 0), gross: t.gross + e.balanceDeltaMinor,
  };
};
const ZERO: Totals = { net: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, gross: 0 };

async function supplierSnapshot(tx: Tx, propertyId: string) {
  const p = await tx.property.findUniqueOrThrow({ where: { id: propertyId } });
  if (p.gstRegistered) {
    if (!p.gstin || !p.gstStateCode || !p.legalName || !p.address) {
      throw new AppError("VALIDATION", "Complete the property's GST details (GSTIN, legal name, address) before issuing invoices.");
    }
  }
  return {
    property: p,
    snapshot: { name: p.legalName ?? p.name, gstin: p.gstin, stateCode: p.gstStateCode, address: p.address, registered: p.gstRegistered },
  };
}

type PendingLine = {
  entryId: string; description: string; quantity: number; sacCode: string | null;
  netMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; cessMinor: number; grossMinor: number; taxDetail: unknown;
};

async function pendingEntries(tx: Tx, folioId: string, entryIds?: string[]) {
  const entries = await tx.folioEntry.findMany({
    where: {
      folioId, kind: { in: ["CHARGE", "DISCOUNT"] }, line: null,
      ...(entryIds ? { id: { in: entryIds } } : {}),
    },
    orderBy: { postedAt: "asc" },
  });
  if (entryIds && entries.length !== entryIds.length) {
    throw new AppError("CONFLICT", "Some selected charges were already invoiced or do not belong to this folio.");
  }
  if (entries.length === 0) throw new AppError("VALIDATION", "There are no uninvoiced charges on this folio.");
  return entries;
}

function toLines(entries: Awaited<ReturnType<typeof pendingEntries>>): PendingLine[] {
  return entries.map((e) => {
    const d = (e.taxDetail ?? {}) as Partial<TaxDetail>;
    return {
      entryId: e.id, description: e.description, quantity: e.quantity, sacCode: d.sacCode ?? null, netMinor: e.netMinor,
      cgstMinor: d.cgstMinor ?? 0, sgstMinor: d.sgstMinor ?? 0, igstMinor: d.igstMinor ?? 0, cessMinor: d.cessMinor ?? 0,
      grossMinor: e.balanceDeltaMinor, taxDetail: e.taxDetail,
    };
  });
}

function documentKind(registered: boolean, entries: { taxDetail: unknown }[]): "TAX_INVOICE" | "BILL_OF_SUPPLY" {
  const taxable = entries.some((e) => (e.taxDetail as TaxDetail | null)?.treatment === "TAXABLE");
  return registered && taxable ? "TAX_INVOICE" : "BILL_OF_SUPPLY";
}

/** Draft invoice: computed from saved ledger entries only, never persisted and never from browser totals. */
export async function previewInvoice(db: PrismaClient, ctx: Ctx, folioId: string, input: { entryIds?: string[]; recipient?: Recipient } = {}) {
  authorize(ctx, "invoices.issue");
  requireProperty(ctx);
  const recipientIn = recipientSchema.parse(input.recipient);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const folio = await tx.folio.findFirst({ where: { id: folioId, propertyId: ctx.propertyId! }, include: { reservation: { include: { guest: true } } } });
    if (!folio) throw new AppError("NOT_FOUND", "Folio not found.");
    const { snapshot } = await supplierSnapshot(tx, folio.propertyId);
    const entries = await pendingEntries(tx, folioId, input.entryIds);
    const recipient = resolveRecipient(folio.reservation.guest, recipientIn);
    const totals = entries.reduce(addTotals, ZERO);
    return { kind: documentKind(snapshot.registered, entries), supplier: snapshot, recipient, lines: toLines(entries), totals };
  });
}

async function nextNumber(tx: Tx, ctx: Ctx, propertyId: string, series: string, fy: string) {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    INSERT INTO invoice_sequences (id, "tenantId", "propertyId", series, "financialYear", next)
    VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${propertyId}::uuid, ${series}, ${fy}, 2)
    ON CONFLICT ("propertyId", series, "financialYear") DO UPDATE SET next = invoice_sequences.next + 1
    RETURNING next - 1 AS seq`;
  const seq = Number(rows[0].seq);
  const number = `${series}/${fy}/${String(seq).padStart(6, "0")}`;
  if (number.length > 16) throw new AppError("VALIDATION", "Invoice number would exceed 16 characters; shorten the prefix.");
  return { seq, number };
}

const seriesFor = (prefix: string, kind: string) =>
  kind === "TAX_INVOICE" ? prefix : kind === "BILL_OF_SUPPLY" ? `${prefix}B` : kind === "CREDIT_NOTE" ? `${prefix}C` : `${prefix}D`;

export async function issueInvoice(db: PrismaClient, ctx: Ctx, folioId: string, input: { entryIds?: string[]; recipient?: Recipient } = {}) {
  authorize(ctx, "invoices.issue");
  requireProperty(ctx);
  const recipientIn = recipientSchema.parse(input.recipient);
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const folio0 = await lockFolio(tx, ctx, folioId);
      const folio = await tx.folio.findUniqueOrThrow({ where: { id: folio0.id }, include: { reservation: { include: { guest: true } } } });
      const { property, snapshot } = await supplierSnapshot(tx, folio.propertyId);
      const entries = await pendingEntries(tx, folioId, input.entryIds);
      const recipient = resolveRecipient(folio.reservation.guest, recipientIn);
      const kind = documentKind(snapshot.registered, entries);
      const totals = entries.reduce(addTotals, ZERO);
      if (totals.gross < 0) throw new AppError("VALIDATION", "An invoice cannot have a negative total.");
      const date = todayIn(property.timezone);
      const fy = financialYear(date);
      const { seq, number } = await nextNumber(tx, ctx, property.id, seriesFor(property.invoicePrefix, kind), fy);
      const pos = (entries[0].taxDetail as TaxDetail | null)?.placeOfSupplyState ?? snapshot.stateCode ?? null;

      const inv = await tx.invoice.create({
        data: {
          tenantId: ctx.tenantId, propertyId: property.id, folioId, kind, series: seriesFor(property.invoicePrefix, kind),
          financialYear: fy, seq, number, supplier: snapshot, recipient, placeOfSupply: pos, netMinor: totals.net,
          cgstMinor: totals.cgst, sgstMinor: totals.sgst, igstMinor: totals.igst, cessMinor: totals.cess, grossMinor: totals.gross,
          issuedBy: ctx.userId,
          lines: {
            create: toLines(entries).map((l) => ({
              tenantId: ctx.tenantId, folioEntryId: l.entryId, description: l.description, sacCode: l.sacCode, quantity: l.quantity,
              netMinor: l.netMinor, cgstMinor: l.cgstMinor, sgstMinor: l.sgstMinor, igstMinor: l.igstMinor, cessMinor: l.cessMinor,
              grossMinor: l.grossMinor, taxDetail: l.taxDetail as Prisma.InputJsonValue,
            })),
          },
        },
      });
      await audit(tx, ctx, {
        action: "invoice.issue", entityType: "Invoice", entityId: inv.id,
        after: { number, kind, grossMinor: totals.gross, lines: entries.length },
      });
      return inv;
    });
  } catch (e) {
    // The unique index on invoice_lines.folioEntryId stops two concurrent issues from invoicing the same charge.
    if (e instanceof Error && /Unique constraint|P2002|folioEntryId/.test(e.message)) {
      throw new AppError("CONFLICT", "Those charges were just invoiced by someone else.");
    }
    throw e;
  }
}

/**
 * Credit note against an issued invoice. Issued invoices are never edited: the lines are reversed in the ledger
 * (a reversal entry per line) and a separate credit-note document is numbered in its own series.
 */
export async function issueCreditNote(db: PrismaClient, ctx: Ctx, invoiceId: string, input: { reason: string; lineEntryIds?: string[] }) {
  authorize(ctx, "creditnotes.issue");
  requireProperty(ctx);
  const reason = z.string().trim().min(3).max(300).parse(input.reason);
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const orig = await tx.invoice.findFirst({ where: { id: invoiceId, propertyId: ctx.propertyId! }, include: { lines: { include: { entry: true } } } });
      if (!orig) throw new AppError("NOT_FOUND", "Invoice not found.");
      if (orig.kind !== "TAX_INVOICE" && orig.kind !== "BILL_OF_SUPPLY") throw new AppError("CONFLICT", "Credit notes can only be raised against invoices.");
      await lockFolio(tx, ctx, orig.folioId);
      const property = await tx.property.findUniqueOrThrow({ where: { id: orig.propertyId } });

      let lines = orig.lines;
      if (input.lineEntryIds) {
        lines = lines.filter((l) => input.lineEntryIds!.includes(l.folioEntryId));
        if (lines.length !== input.lineEntryIds.length) throw new AppError("VALIDATION", "Some selected lines are not on that invoice.");
      }
      const already = await tx.folioEntry.findMany({ where: { reversesEntryId: { in: lines.map((l) => l.folioEntryId) } } });
      if (already.length) throw new AppError("CONFLICT", "Some of those lines have already been credited.");
      if (lines.length === 0) throw new AppError("VALIDATION", "Nothing to credit.");

      const date = todayIn(property.timezone);
      const fy = financialYear(date);
      const series = seriesFor(property.invoicePrefix, "CREDIT_NOTE");
      const { seq, number } = await nextNumber(tx, ctx, property.id, series, fy);

      const reversals: { line: (typeof lines)[number]; id: string }[] = [];
      for (const l of lines) {
        const o = l.entry;
        const d = o.taxDetail as unknown as TaxDetail | null;
        const neg = d
          ? { ...d, cgstMinor: -d.cgstMinor, sgstMinor: -d.sgstMinor, igstMinor: -d.igstMinor, cessMinor: -d.cessMinor }
          : null;
        const rev = await tx.folioEntry.create({
          data: {
            tenantId: ctx.tenantId, propertyId: o.propertyId, folioId: o.folioId, kind: "REVERSAL", category: o.category,
            description: `Credit note ${number}: ${o.description}`, quantity: o.quantity, netMinor: -o.netMinor,
            taxMinor: -o.taxMinor, balanceDeltaMinor: -o.balanceDeltaMinor, taxInclusive: o.taxInclusive,
            taxDetail: neg as unknown as Prisma.InputJsonValue, taxRuleId: o.taxRuleId, serviceDate: o.serviceDate,
            reversesEntryId: o.id, reason, postedBy: ctx.userId,
          },
        });
        reversals.push({ line: l, id: rev.id });
        const flip = o.balanceDeltaMinor < 0; // reversing a discount re-debits revenue
        // `normalIsCredit` describes the ORIGINAL posting side. A reversal posts the opposite side;
        // reversing a discount (flip) swaps it back.
        const side = (code: string, amt: number, normalIsCredit: boolean) => {
          const a = Math.abs(amt);
          const credit = normalIsCredit === flip;
          return credit ? { code, credit: a } : { code, debit: a };
        };
        const rc = o.category === "ROOM" ? ACCOUNT.REV_ROOM : o.category === "FNB" ? ACCOUNT.REV_FNB : o.category === "SPA" ? ACCOUNT.REV_SPA : o.category === "BANQUET" ? ACCOUNT.REV_BANQUET : ACCOUNT.REV_OTHER;
        await postJournal(tx, ctx, {
          date, memo: `Credit note ${number}`, sourceType: "FOLIO_ENTRY", sourceId: rev.id,
          lines: [
            side(ACCOUNT.RECEIVABLE, o.balanceDeltaMinor, false),
            side(rc, o.netMinor, true),
            side(ACCOUNT.CGST, d?.cgstMinor ?? 0, true),
            side(ACCOUNT.SGST, d?.sgstMinor ?? 0, true),
            side(ACCOUNT.IGST, d?.igstMinor ?? 0, true),
            side(ACCOUNT.CESS, d?.cessMinor ?? 0, true),
          ],
        });
      }
      const tot = lines.reduce(
        (t, l) => ({
          net: t.net - l.netMinor, cgst: t.cgst - l.cgstMinor, sgst: t.sgst - l.sgstMinor, igst: t.igst - l.igstMinor,
          cess: t.cess - l.cessMinor, gross: t.gross - l.grossMinor,
        }),
        ZERO,
      );
      const cn = await tx.invoice.create({
        data: {
          tenantId: ctx.tenantId, propertyId: orig.propertyId, folioId: orig.folioId, kind: "CREDIT_NOTE", series, financialYear: fy,
          seq, number, originalInvoiceId: orig.id, supplier: orig.supplier as Prisma.InputJsonValue, recipient: orig.recipient as Prisma.InputJsonValue,
          placeOfSupply: orig.placeOfSupply, netMinor: tot.net, cgstMinor: tot.cgst, sgstMinor: tot.sgst, igstMinor: tot.igst,
          cessMinor: tot.cess, grossMinor: tot.gross, reason, issuedBy: ctx.userId,
          lines: {
            create: reversals.map(({ line: l, id }) => ({
              tenantId: ctx.tenantId, folioEntryId: id, description: l.description, sacCode: l.sacCode, quantity: l.quantity,
              netMinor: -l.netMinor, cgstMinor: -l.cgstMinor, sgstMinor: -l.sgstMinor, igstMinor: -l.igstMinor,
              cessMinor: -l.cessMinor, grossMinor: -l.grossMinor, taxDetail: l.taxDetail as Prisma.InputJsonValue,
            })),
          },
        },
      });
      await audit(tx, ctx, {
        action: "creditnote.issue", entityType: "Invoice", entityId: cn.id, reason,
        after: { number, originalInvoice: orig.number, grossMinor: tot.gross },
      });
      return cn;
    });
  } catch (e) {
    if (e instanceof Error && /Unique constraint|P2002/.test(e.message)) {
      throw new AppError("CONFLICT", "Those lines were just credited by someone else.");
    }
    throw e;
  }
}

export async function listInvoices(db: PrismaClient, ctx: Ctx, kinds?: string[]) {
  authorize(ctx, "billing.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.invoice.findMany({ where: { propertyId, ...(kinds ? { kind: { in: kinds } } : {}) }, orderBy: { issuedAt: "desc" }, take: 200 }),
  );
}

export async function getInvoice(db: PrismaClient, ctx: Ctx, id: string) {
  authorize(ctx, "billing.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id, propertyId }, include: { lines: true } });
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found.");
    const original = inv.originalInvoiceId ? await tx.invoice.findUnique({ where: { id: inv.originalInvoiceId }, select: { number: true } }) : null;
    return { ...inv, originalNumber: original?.number ?? null, issuedDate: iso(inv.issuedAt) };
  });
}
