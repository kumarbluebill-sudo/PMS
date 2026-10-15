import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { calculateTax, TaxEngineError, type TaxResult, type TaxRuleInput } from "@/server/domain/gst";
import { extraPersonPerNight, summarizeFolio } from "@/server/domain/folio";
import { dateInZone } from "@/server/domain/roomStatus";
import { stayNights } from "@/server/domain/stay";
import { audit } from "./audit";
import { loadSettings } from "./settings";

type Tx = Prisma.TransactionClient;

/** Int columns hold paise; guard well below 2^31 so sums and tax maths cannot overflow. */
export const MAX_AMOUNT_MINOR = 1_000_000_000;

export const CATEGORIES = ["ROOM", "FNB", "SPA", "BANQUET", "LAUNDRY", "TRANSPORT", "EXTRA_BED", "OTHER"] as const;
export type Category = (typeof CATEGORIES)[number];

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------- chart of accounts & journal ----------

export const ACCOUNT = {
  CASH: "1010",
  BANK: "1020",
  CLEARING: "1030", // UPI / card / other electronic receipts awaiting settlement
  RECEIVABLE: "1100", // guest folios (a credit balance here represents guest advances)
  COMPANY: "1110", // amounts a company has agreed to pay (company credit)
  CGST: "2100",
  SGST: "2110",
  IGST: "2120",
  CESS: "2130",
  REV_ROOM: "4000",
  REV_FNB: "4100",
  REV_SPA: "4200",
  REV_BANQUET: "4300",
  REV_OTHER: "4900",
} as const;

const DEFAULT_ACCOUNTS: [string, string, string][] = [
  [ACCOUNT.CASH, "Cash in hand", "ASSET"],
  [ACCOUNT.BANK, "Bank", "ASSET"],
  [ACCOUNT.CLEARING, "UPI / card clearing", "ASSET"],
  [ACCOUNT.RECEIVABLE, "Guest receivables", "ASSET"],
  [ACCOUNT.COMPANY, "Company credit receivables", "ASSET"],
  [ACCOUNT.CGST, "Output CGST payable", "LIABILITY"],
  [ACCOUNT.SGST, "Output SGST payable", "LIABILITY"],
  [ACCOUNT.IGST, "Output IGST payable", "LIABILITY"],
  [ACCOUNT.CESS, "Output cess payable", "LIABILITY"],
  [ACCOUNT.REV_ROOM, "Room revenue", "REVENUE"],
  [ACCOUNT.REV_FNB, "Food & beverage revenue", "REVENUE"],
  [ACCOUNT.REV_SPA, "Spa & wellness revenue", "REVENUE"],
  [ACCOUNT.REV_BANQUET, "Banquet & events revenue", "REVENUE"],
  [ACCOUNT.REV_OTHER, "Other service revenue", "REVENUE"],
];

export const revenueAccount = (category: string) =>
  ({ ROOM: ACCOUNT.REV_ROOM, FNB: ACCOUNT.REV_FNB, SPA: ACCOUNT.REV_SPA, BANQUET: ACCOUNT.REV_BANQUET }[category] ??
    ACCOUNT.REV_OTHER);

export const paymentAccount = (method: string) =>
  method === "CASH" ? ACCOUNT.CASH : method === "BANK_TRANSFER" ? ACCOUNT.BANK : method === "COMPANY_CREDIT" ? ACCOUNT.COMPANY : ACCOUNT.CLEARING;

async function accountIds(tx: Tx, tenantId: string): Promise<Map<string, string>> {
  let rows = await tx.account.findMany({ where: { tenantId } });
  if (rows.length < DEFAULT_ACCOUNTS.length) {
    await tx.account.createMany({
      data: DEFAULT_ACCOUNTS.map(([code, name, type]) => ({ tenantId, code, name, type })),
      skipDuplicates: true,
    });
    rows = await tx.account.findMany({ where: { tenantId } });
  }
  return new Map(rows.map((a) => [a.code, a.id]));
}

export type JournalSpec = { code: string; debit?: number; credit?: number }[];

/** Posts one balanced journal entry per source event (idempotent on source). Balance is also enforced by a DB trigger. */
export async function postJournal(
  tx: Tx,
  ctx: Pick<Ctx, "tenantId" | "userId" | "propertyId">,
  e: { date: string; memo: string; sourceType: string; sourceId: string; lines: JournalSpec },
) {
  const lines = e.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  const d = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (d !== c) throw new AppError("CONFLICT", "Internal accounting error: journal entry does not balance.");
  if (lines.length === 0) return;
  const ids = await accountIds(tx, ctx.tenantId);
  const entry = await tx.journalEntry.create({
    data: {
      tenantId: ctx.tenantId, propertyId: ctx.propertyId, date: new Date(`${e.date}T00:00:00.000Z`), memo: e.memo,
      sourceType: e.sourceType, sourceId: e.sourceId, createdBy: ctx.userId,
    },
  });
  await tx.journalLine.createMany({
    data: lines.map((l) => ({
      tenantId: ctx.tenantId, entryId: entry.id, accountId: ids.get(l.code)!,
      debitMinor: l.debit ?? 0, creditMinor: l.credit ?? 0,
    })),
  });
}

/** Journal lines for a (signed) charge: positive = Dr receivable / Cr revenue + tax; negative flips every side. */
export function chargeJournal(category: string, detail: TaxResult["detail"], net: number, gross: number): JournalSpec {
  const flip = gross < 0;
  const side = (code: string, amt: number, normalIsCredit: boolean) => {
    const a = Math.abs(amt);
    const credit = normalIsCredit !== flip;
    return credit ? { code, credit: a } : { code, debit: a };
  };
  return [
    side(ACCOUNT.RECEIVABLE, gross, false),
    side(revenueAccount(category), net, true),
    side(ACCOUNT.CGST, detail.cgstMinor, true),
    side(ACCOUNT.SGST, detail.sgstMinor, true),
    side(ACCOUNT.IGST, detail.igstMinor, true),
    side(ACCOUNT.CESS, detail.cessMinor, true),
  ];
}

// ---------- tax context ----------

export async function loadRules(tx: Tx, tenantId: string): Promise<TaxRuleInput[]> {
  const rows = await tx.taxRule.findMany({ where: { tenantId, status: "APPROVED" } });
  return rows.map((r) => ({
    id: r.id, category: r.category, sacCode: r.sacCode, treatment: r.treatment as TaxRuleInput["treatment"],
    rateBp: r.rateBp, cessBp: r.cessBp, tariffMinMinor: r.tariffMinMinor, tariffMaxMinor: r.tariffMaxMinor,
    placeOfSupply: r.placeOfSupply as TaxRuleInput["placeOfSupply"], effectiveFrom: iso(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? iso(r.effectiveTo) : null, legalRef: r.legalRef, version: r.version,
    status: r.status as TaxRuleInput["status"],
  }));
}

async function computeTax(
  tx: Tx,
  ctx: Ctx,
  folio: { propertyId: string; guestId: string },
  line: { amountMinor: number; taxInclusive: boolean; category: string; serviceDate: string; unitTariffMinor: number },
): Promise<TaxResult> {
  const [property, guest, rules] = await Promise.all([
    tx.property.findUniqueOrThrow({ where: { id: folio.propertyId } }),
    tx.guest.findUniqueOrThrow({ where: { id: folio.guestId } }),
    loadRules(tx, ctx.tenantId),
  ]);
  try {
    return calculateTax(
      line,
      { supplierRegistered: property.gstRegistered, supplierStateCode: property.gstStateCode, recipientStateCode: guest.gstStateCode },
      rules,
    );
  } catch (e) {
    if (e instanceof TaxEngineError) throw new AppError("VALIDATION", e.message);
    throw e;
  }
}

// ---------- folios ----------

export async function ensureFolio(tx: Tx, ctx: Ctx, reservationId: string, label: "GUEST" | "COMPANY" = "GUEST", billTo?: string) {
  const r = await tx.reservation.findFirst({ where: { id: reservationId, propertyId: ctx.propertyId ?? undefined } });
  if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
  const existing = await tx.folio.findUnique({ where: { reservationId_label: { reservationId, label } } });
  if (existing) return existing;
  return tx.folio.create({
    data: { tenantId: ctx.tenantId, propertyId: r.propertyId, reservationId, guestId: r.guestId, label, billTo },
  });
}

async function lockFolio(tx: Tx, ctx: Ctx, folioId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM folios WHERE id = ${folioId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new AppError("NOT_FOUND", "Folio not found.");
  const folio = await tx.folio.findFirstOrThrow({ where: { id: folioId, propertyId: ctx.propertyId ?? undefined } });
  return folio;
}
export { lockFolio };

export async function folioBalance(tx: Tx, folioId: string): Promise<number> {
  const a = await tx.folioEntry.aggregate({ where: { folioId }, _sum: { balanceDeltaMinor: true } });
  return a._sum.balanceDeltaMinor ?? 0;
}

const chargeSchema = z.object({
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(2).max(200),
  amountMinor: z.number().int().positive().max(MAX_AMOUNT_MINOR),
  taxInclusive: z.boolean().default(false),
  quantity: z.number().int().min(1).max(10000).default(1),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export async function insertCharge(
  tx: Tx,
  ctx: Ctx,
  folio: { id: string; propertyId: string; guestId: string },
  kind: "CHARGE" | "DISCOUNT",
  d: z.infer<typeof chargeSchema>,
  reason?: string,
  unitTariffOverride?: number,
  subCategory?: string,
) {
  const date = d.serviceDate ?? iso(new Date());
  const signed = kind === "DISCOUNT" ? -d.amountMinor : d.amountMinor;
  // For banded rules the tariff is the per-unit amount (e.g. room rate per night).
  const unit = unitTariffOverride ?? Math.floor(d.amountMinor / d.quantity);
  const tax = await computeTax(tx, ctx, folio, {
    amountMinor: signed, taxInclusive: d.taxInclusive, category: d.category, serviceDate: date, unitTariffMinor: unit,
  });
  const entry = await tx.folioEntry.create({
    data: {
      tenantId: ctx.tenantId, propertyId: folio.propertyId, folioId: folio.id, kind, category: d.category, subCategory,
      description: d.description, quantity: d.quantity, netMinor: tax.netMinor, taxMinor: tax.taxMinor,
      balanceDeltaMinor: tax.grossMinor, taxInclusive: d.taxInclusive, taxDetail: tax.detail,
      taxRuleId: tax.detail.ruleId, serviceDate: new Date(`${date}T00:00:00.000Z`), reason,
      idempotencyKey: d.idempotencyKey, postedBy: ctx.userId,
    },
  });
  await postJournal(tx, ctx, {
    date, memo: `${kind.toLowerCase()} ${d.description}`.slice(0, 120), sourceType: "FOLIO_ENTRY", sourceId: entry.id,
    lines: chargeJournal(d.category, tax.detail, tax.netMinor, tax.grossMinor),
  });
  return entry;
}

export async function postCharge(db: PrismaClient, ctx: Ctx, folioId: string, input: unknown) {
  authorize(ctx, "billing.post");
  requireProperty(ctx);
  const d = chargeSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const folio = await lockFolio(tx, ctx, folioId);
    if (folio.status !== "OPEN") throw new AppError("CONFLICT", "This folio is closed.");
    if (d.idempotencyKey) {
      const dup = await tx.folioEntry.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: d.idempotencyKey } });
      if (dup) return dup;
    }
    if (d.serviceDate) {
      // The posting date must fall within the stay and not be in the future.
      const [res, prop] = await Promise.all([
        tx.reservation.findUniqueOrThrow({ where: { id: folio.reservationId }, select: { arrival: true } }),
        tx.property.findUniqueOrThrow({ where: { id: folio.propertyId }, select: { timezone: true } }),
      ]);
      const today = dateInZone(new Date(), prop.timezone);
      if (d.serviceDate < iso(res.arrival) || d.serviceDate > today) {
        throw new AppError("VALIDATION", "The posting date must be between check-in and today.");
      }
    }
    const entry = await insertCharge(tx, ctx, folio, "CHARGE", d);
    await audit(tx, ctx, {
      action: "folio.charge", entityType: "FolioEntry", entityId: entry.id,
      after: { category: d.category, grossMinor: entry.balanceDeltaMinor, taxMinor: entry.taxMinor },
    });
    return entry;
  });
}

export async function postDiscount(db: PrismaClient, ctx: Ctx, folioId: string, input: unknown, reason: string) {
  authorize(ctx, "billing.discount");
  requireProperty(ctx);
  if (!reason.trim()) throw new AppError("VALIDATION", "A reason is required for a discount.");
  const d = chargeSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const folio = await lockFolio(tx, ctx, folioId);
    if (folio.status !== "OPEN") throw new AppError("CONFLICT", "This folio is closed.");
    const entries = await tx.folioEntry.findMany({
      where: { folioId, category: d.category, kind: { in: ["CHARGE", "DISCOUNT", "REVERSAL"] } },
    });
    const available = entries.reduce((s, e) => s + e.balanceDeltaMinor, 0);
    // Use the tariff of the charge being discounted so the same tax band applies.
    const lastCharge = entries.filter((e) => e.kind === "CHARGE").sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())[0];
    if (!lastCharge) throw new AppError("VALIDATION", "There is no charge in that category to discount.");
    const st = await loadSettings(tx, ctx.tenantId, ctx.propertyId);
    const charged = entries.filter((e) => e.kind === "CHARGE").reduce((s, e) => s + e.balanceDeltaMinor, 0);
    const alreadyDiscounted = entries.filter((e) => e.kind === "DISCOUNT").reduce((s, e) => s - e.balanceDeltaMinor, 0);
    if (st["billing.maxDiscountPercent"] < 100 && (alreadyDiscounted + d.amountMinor) * 100 > charged * st["billing.maxDiscountPercent"]) {
      throw new AppError("VALIDATION", `Discounts are limited to ${st["billing.maxDiscountPercent"]}% of the charges at this property.`);
    }
    const unit = Math.floor(lastCharge.netMinor / lastCharge.quantity);
    const entry = await insertCharge(tx, ctx, folio, "DISCOUNT", d, reason.trim(), unit);
    if (available + entry.balanceDeltaMinor < 0) {
      throw new AppError("VALIDATION", "A discount cannot exceed the charges in that category.");
    }
    await audit(tx, ctx, {
      action: "folio.discount", entityType: "FolioEntry", entityId: entry.id,
      after: { category: d.category, grossMinor: entry.balanceDeltaMinor }, reason: reason.trim(),
    });
    return entry;
  });
}

/**
 * Posts one room charge per night not yet posted (idempotent per reservation night), plus an extra-person charge
 * for guests beyond the room type's base occupancy. Runs inside the caller's transaction.
 */
export async function postRoomNightsTx(tx: Tx, ctx: Ctx, reservationId: string) {
  const r = await tx.reservation.findFirstOrThrow({ where: { id: reservationId } });
  const rt = await tx.roomType.findFirstOrThrow({ where: { id: r.roomTypeId } });
  const folio = await ensureFolio(tx, ctx, reservationId);
  if (folio.status !== "OPEN") return { posted: 0, folioId: folio.id };
  // A discounted booking carries its agreed nightly rate; otherwise the room type's base rate applies.
  const rate = r.agreedRateMinor ?? rt.baseRateMinor;
  if (rate <= 0) return { posted: 0, folioId: folio.id };
  const extra = extraPersonPerNight({ adults: r.adults, children: r.children, ...rt });
  // The tax band is chosen from the whole nightly tariff, so both lines are banded on rate + extras.
  const tariff = rate + extra;
  let posted = 0;
  for (const night of stayNights(iso(r.arrival), iso(r.departure))) {
    const key = `room:${reservationId}:${night}`;
    if (!(await tx.folioEntry.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: key } }))) {
      await insertCharge(tx, ctx, folio, "CHARGE", {
        category: "ROOM", description: `Room charge ${night}`, amountMinor: rate, taxInclusive: false,
        quantity: 1, serviceDate: night, idempotencyKey: key,
      }, undefined, tariff);
      posted += 1;
    }
    const extraKey = `extra:${reservationId}:${night}`;
    if (extra > 0 && !(await tx.folioEntry.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: extraKey } }))) {
      await insertCharge(tx, ctx, folio, "CHARGE", {
        category: "ROOM", description: `Extra person charge ${night}`, amountMinor: extra, taxInclusive: false,
        quantity: 1, serviceDate: night, idempotencyKey: extraKey,
      }, undefined, tariff, "EXTRA_PERSON");
      posted += 1;
    }
  }
  return { posted, folioId: folio.id };
}

export async function postRoomNights(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "billing.post");
  requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const res = await postRoomNightsTx(tx, ctx, reservationId);
    if (res.posted) await audit(tx, ctx, { action: "folio.room_nights", entityType: "Reservation", entityId: reservationId, after: { posted: res.posted } });
    return res;
  });
}

/** Opens (creating if needed) the folio for a reservation. */
export async function openFolio(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "billing.view");
  requireProperty(ctx);
  return withTenant(db, ctx.tenantId, (tx) => ensureFolio(tx, ctx, reservationId));
}

export async function folioDetail(db: PrismaClient, ctx: Ctx, folioId: string) {
  authorize(ctx, "billing.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const folio = await tx.folio.findFirst({
      where: { id: folioId, propertyId },
      include: {
        entries: { orderBy: { postedAt: "asc" }, include: { line: { include: { invoice: { select: { number: true, kind: true } } } } } },
        reservation: { include: { guest: true } },
        invoices: { orderBy: { issuedAt: "asc" } },
      },
    });
    if (!folio) throw new AppError("NOT_FOUND", "Folio not found.");
    const balance = folio.entries.reduce((s, e) => s + e.balanceDeltaMinor, 0);
    const paid = folio.entries.filter((e) => e.kind === "PAYMENT").reduce((s, e) => s - e.balanceDeltaMinor, 0);
    const refunded = folio.entries.filter((e) => e.kind === "REFUND").reduce((s, e) => s + e.balanceDeltaMinor, 0);
    const billed = folio.entries.filter((e) => ["CHARGE", "DISCOUNT", "REVERSAL"].includes(e.kind)).reduce((s, e) => s + e.balanceDeltaMinor, 0);
    const paymentStatus =
      refunded > 0 && paid - refunded <= 0 ? "REFUNDED"
      : refunded > 0 ? "PARTIALLY_REFUNDED"
      : billed > 0 && paid === 0 ? "UNPAID"
      : balance > 0 ? "PARTIALLY_PAID"
      : paid > 0 ? "PAID" : "UNPAID";
    const checkedIn = await tx.reservationStatusHistory.findFirst({
      where: { reservationId: folio.reservationId, toStatus: "CHECKED_IN" }, orderBy: { changedAt: "asc" }, select: { changedAt: true },
    });
    const summary = summarizeFolio(folio.entries, checkedIn?.changedAt ?? null);
    const siblings = await tx.folio.findMany({
      where: { reservationId: folio.reservationId, id: { not: folio.id } }, select: { id: true, label: true, billTo: true },
    });
    const payIds = folio.entries.map((e) => e.paymentId).filter((x): x is string => !!x);
    const pays = payIds.length ? await tx.payment.findMany({ where: { id: { in: payIds } }, select: { id: true, method: true, reference: true } }) : [];
    const paymentRefs = new Map(pays.map((x) => [x.id, `${x.method.replace("_", " ").toLowerCase()}${x.reference ? ` · ${x.reference}` : ""}`]));
    return { folio, balance, paid, refunded, billed, paymentStatus, summary, siblings, paymentRefs };
  });
}

/**
 * Reverses one ledger entry (a REVERSAL entry with the opposite sign plus its journal entry). Used by credit notes
 * and by folio transfers. The original entry is never touched.
 */
export async function reverseEntryTx(
  tx: Tx,
  ctx: Ctx,
  o: Prisma.FolioEntryGetPayload<object>,
  opts: { description: string; reason: string; date: string },
) {
  const d = o.taxDetail as unknown as TaxResult["detail"] | null;
  const neg = d ? { ...d, cgstMinor: -d.cgstMinor, sgstMinor: -d.sgstMinor, igstMinor: -d.igstMinor, cessMinor: -d.cessMinor } : null;
  const rev = await tx.folioEntry.create({
    data: {
      tenantId: ctx.tenantId, propertyId: o.propertyId, folioId: o.folioId, kind: "REVERSAL", category: o.category,
      subCategory: o.subCategory, description: opts.description, quantity: o.quantity, netMinor: -o.netMinor,
      taxMinor: -o.taxMinor, balanceDeltaMinor: -o.balanceDeltaMinor, taxInclusive: o.taxInclusive,
      taxDetail: neg as unknown as Prisma.InputJsonValue, taxRuleId: o.taxRuleId, serviceDate: o.serviceDate,
      reversesEntryId: o.id, reason: opts.reason, postedBy: ctx.userId,
    },
  });
  // `normalIsCredit` describes the ORIGINAL posting side. A reversal posts the opposite side; reversing a discount swaps it back.
  const flip = o.balanceDeltaMinor < 0;
  const side = (code: string, amt: number, normalIsCredit: boolean) => {
    const a = Math.abs(amt);
    return normalIsCredit === flip ? { code, credit: a } : { code, debit: a };
  };
  await postJournal(tx, ctx, {
    date: opts.date, memo: opts.description.slice(0, 120), sourceType: "FOLIO_ENTRY", sourceId: rev.id,
    lines: [
      side(ACCOUNT.RECEIVABLE, o.balanceDeltaMinor, false),
      side(revenueAccount(o.category), o.netMinor, true),
      side(ACCOUNT.CGST, d?.cgstMinor ?? 0, true),
      side(ACCOUNT.SGST, d?.sgstMinor ?? 0, true),
      side(ACCOUNT.IGST, d?.igstMinor ?? 0, true),
      side(ACCOUNT.CESS, d?.cessMinor ?? 0, true),
    ],
  });
  return rev;
}

export async function listFolios(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "billing.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const folios = await tx.folio.findMany({
      where: { propertyId }, orderBy: { createdAt: "desc" }, take: 100,
      include: { reservation: { include: { guest: { select: { name: true } } } } },
    });
    const sums = await tx.folioEntry.groupBy({ by: ["folioId"], where: { folioId: { in: folios.map((f) => f.id) } }, _sum: { balanceDeltaMinor: true } });
    const bal = new Map(sums.map((s) => [s.folioId, s._sum.balanceDeltaMinor ?? 0]));
    return folios.map((f) => ({ ...f, balance: bal.get(f.id) ?? 0 }));
  });
}
