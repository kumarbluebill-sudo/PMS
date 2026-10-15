import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { calculateTax, GST_STATES, selectRule, TaxEngineError, validateGstin, type TaxRuleInput } from "@/server/domain/gst";
import { ACCOMMODATION_PRESETS, presetById } from "@/server/domain/gstPresets";
import { dateInZone } from "@/server/domain/roomStatus";
import { audit } from "./audit";
import { CATEGORIES } from "./billing";
import { loadSettings, setSettings } from "./settings";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

const ruleSchema = z
  .object({
    category: z.enum(CATEGORIES),
    sacCode: z.string().trim().regex(/^\d{4,8}$/, "SAC must be 4-8 digits").optional(),
    description: z.string().trim().min(3).max(200),
    treatment: z.enum(["TAXABLE", "EXEMPT", "NIL_RATED"]),
    ratePercent: z.number().min(0).max(100).default(0), // entered as a percentage, stored as basis points
    cessPercent: z.number().min(0).max(100).default(0),
    tariffMinMinor: z.number().int().min(0).optional(),
    tariffMaxMinor: z.number().int().min(1).optional(),
    placeOfSupply: z.enum(["PROPERTY_STATE", "RECIPIENT_STATE"]).default("PROPERTY_STATE"),
    effectiveFrom: day,
    effectiveTo: day.optional(),
    legalRef: z.string().trim().max(300).optional(),
  })
  .refine((r) => !r.effectiveTo || r.effectiveTo > r.effectiveFrom, { message: "Effective-to must be after effective-from." })
  .refine((r) => r.tariffMinMinor === undefined || r.tariffMaxMinor === undefined || r.tariffMaxMinor > r.tariffMinMinor, {
    message: "Tariff maximum must exceed the minimum.",
  })
  .refine((r) => r.treatment === "TAXABLE" || (r.ratePercent === 0 && r.cessPercent === 0), {
    message: "Exempt and nil-rated rules must have a zero rate.",
  });

const bp = (pct: number) => Math.round(pct * 100);

export async function listRules(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "tax.manage");
  return withTenant(db, ctx.tenantId, (tx) =>
    tx.taxRule.findMany({ where: { tenantId: ctx.tenantId }, orderBy: [{ category: "asc" }, { effectiveFrom: "desc" }, { version: "desc" }] }),
  );
}

export async function createRule(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "tax.manage");
  const d = ruleSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const prev = await tx.taxRule.aggregate({ where: { tenantId: ctx.tenantId, category: d.category }, _max: { version: true } });
    const rule = await tx.taxRule.create({
      data: {
        tenantId: ctx.tenantId, category: d.category, sacCode: d.sacCode, description: d.description, treatment: d.treatment,
        rateBp: bp(d.ratePercent), cessBp: bp(d.cessPercent), tariffMinMinor: d.tariffMinMinor, tariffMaxMinor: d.tariffMaxMinor,
        placeOfSupply: d.placeOfSupply, effectiveFrom: toDate(d.effectiveFrom), effectiveTo: d.effectiveTo ? toDate(d.effectiveTo) : null,
        legalRef: d.legalRef, version: (prev._max.version ?? 0) + 1, status: "DRAFT", createdBy: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "tax.rule_create", entityType: "TaxRule", entityId: rule.id, after: { category: d.category, rateBp: rule.rateBp, status: "DRAFT" } });
    return rule;
  });
}

/** Maker-checker: the approver must be a different user from the creator. */
export async function approveRule(db: PrismaClient, ctx: Ctx, ruleId: string) {
  authorize(ctx, "tax.approve");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rule = await tx.taxRule.findFirst({ where: { id: ruleId, tenantId: ctx.tenantId } });
    if (!rule) throw new AppError("NOT_FOUND", "Tax rule not found.");
    if (rule.status !== "DRAFT") throw new AppError("CONFLICT", "Only draft rules can be approved.");
    if (rule.createdBy === ctx.userId) throw new AppError("FORBIDDEN", "A different authorised user must approve a rule you created.");
    const clash = await tx.taxRule.findMany({
      where: {
        tenantId: ctx.tenantId, category: rule.category, status: "APPROVED",
        effectiveFrom: rule.effectiveTo ? { lt: rule.effectiveTo } : undefined,
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: rule.effectiveFrom } }],
      },
    });
    const overlaps = clash.filter((o) => {
      const aMin = rule.tariffMinMinor ?? 0, aMax = rule.tariffMaxMinor ?? Infinity;
      const bMin = o.tariffMinMinor ?? 0, bMax = o.tariffMaxMinor ?? Infinity;
      return aMin < bMax && bMin < aMax;
    });
    if (overlaps.length) {
      throw new AppError("CONFLICT", "This rule overlaps an approved rule for the same category, dates and tariff band. Retire or end-date the existing rule first.");
    }
    const a = await tx.taxRule.update({ where: { id: rule.id }, data: { status: "APPROVED", approvedBy: ctx.userId, approvedAt: new Date() } });
    await audit(tx, ctx, { action: "tax.rule_approve", entityType: "TaxRule", entityId: rule.id, before: { status: "DRAFT" }, after: { status: "APPROVED", rateBp: rule.rateBp } });
    return a;
  });
}

export async function retireRule(db: PrismaClient, ctx: Ctx, ruleId: string, reason: string) {
  authorize(ctx, "tax.approve");
  if (!reason.trim()) throw new AppError("VALIDATION", "A reason is required.");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rule = await tx.taxRule.findFirst({ where: { id: ruleId, tenantId: ctx.tenantId } });
    if (!rule || rule.status !== "APPROVED") throw new AppError("NOT_FOUND", "Approved rule not found.");
    const r = await tx.taxRule.update({ where: { id: rule.id }, data: { status: "RETIRED" } });
    await audit(tx, ctx, { action: "tax.rule_retire", entityType: "TaxRule", entityId: rule.id, reason: reason.trim() });
    return r;
  });
}

export async function deleteDraftRule(db: PrismaClient, ctx: Ctx, ruleId: string) {
  authorize(ctx, "tax.manage");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rule = await tx.taxRule.findFirst({ where: { id: ruleId, tenantId: ctx.tenantId, status: "DRAFT" } });
    if (!rule) throw new AppError("NOT_FOUND", "Draft rule not found.");
    await tx.taxRule.delete({ where: { id: rule.id } });
    await audit(tx, ctx, { action: "tax.rule_delete_draft", entityType: "TaxRule", entityId: rule.id });
  });
}

const gstSchema = z.object({
  gstRegistered: z.boolean(),
  gstin: z.string().trim().toUpperCase().optional(),
  legalName: z.string().trim().min(2).max(150).optional(),
  address: z.string().trim().min(5).max(300).optional(),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, "Prefix must be 1-4 letters or digits."),
});

/** Changes the property's GST registration. Requires both settings and tax permissions; fully audited with before/after. */
export async function updateGstSettings(db: PrismaClient, ctx: Ctx, input: unknown, reason: string) {
  authorize(ctx, "tax.manage");
  authorize(ctx, "settings.manage");
  const propertyId = requireProperty(ctx);
  const d = gstSchema.parse(input);
  if (!reason.trim()) throw new AppError("VALIDATION", "A reason is required when changing GST settings.");
  let stateCode: string | null = null;
  if (d.gstRegistered) {
    if (!d.gstin) throw new AppError("VALIDATION", "A GSTIN is required for a registered property.");
    const v = validateGstin(d.gstin);
    if (!v.ok) throw new AppError("VALIDATION", v.reason);
    stateCode = v.stateCode;
    if (!d.legalName || !d.address) throw new AppError("VALIDATION", "Legal name and address are required on GST invoices.");
  }
  return withTenant(db, ctx.tenantId, async (tx) => {
    const before = await tx.property.findFirstOrThrow({ where: { id: propertyId } });
    const issued = await tx.invoice.count({ where: { propertyId } });
    if (issued > 0 && before.invoicePrefix !== d.invoicePrefix) {
      throw new AppError("CONFLICT", "The invoice prefix cannot change after invoices have been issued.");
    }
    const p = await tx.property.update({
      where: { id: propertyId },
      data: {
        gstRegistered: d.gstRegistered, gstin: d.gstRegistered ? d.gstin : null, gstStateCode: stateCode,
        legalName: d.legalName ?? before.legalName, address: d.address ?? before.address, invoicePrefix: d.invoicePrefix,
      },
    });
    await audit(tx, ctx, {
      action: "tax.gst_settings", entityType: "Property", entityId: propertyId, reason: reason.trim(),
      before: { gstRegistered: before.gstRegistered, gstin: before.gstin, state: before.gstStateCode, prefix: before.invoicePrefix },
      after: { gstRegistered: p.gstRegistered, gstin: p.gstin, state: p.gstStateCode, prefix: p.invoicePrefix },
    });
    return p;
  });
}

export const stateName = (code: string | null | undefined) => (code ? GST_STATES[code] ?? code : "");
export const fmtRuleDate = iso;

// ---------------------------------------------------------------- setup wizard support

const minorOf = (n: number | null | undefined) => n ?? null;

/**
 * Creates the rules of a preset as DRAFTS. A rule that already exists (same category, band, start date and rate, and not
 * retired) is skipped, so applying twice does nothing. Approval is still a separate step by a second person.
 */
export async function applyPreset(db: PrismaClient, ctx: Ctx, presetId: string) {
  authorize(ctx, "tax.manage");
  const preset = presetById(presetId);
  if (!preset) throw new AppError("NOT_FOUND", "That preset does not exist.");
  const existing = await withTenant(db, ctx.tenantId, (tx) => tx.taxRule.findMany({ where: { tenantId: ctx.tenantId, status: { not: "RETIRED" } } }));
  let created = 0, skipped = 0;
  for (const r of preset.rules) {
    const dup = existing.find((e) => e.category === r.category && iso(e.effectiveFrom) === r.effectiveFrom && minorOf(e.tariffMinMinor) === minorOf(r.tariffMinMinor) && minorOf(e.tariffMaxMinor) === minorOf(r.tariffMaxMinor) && e.rateBp === bp(r.ratePercent));
    if (dup) { skipped++; continue; }
    await createRule(db, ctx, { ...r, tariffMinMinor: r.tariffMinMinor, tariffMaxMinor: r.tariffMaxMinor });
    created++;
  }
  await withTenant(db, ctx.tenantId, (tx) => audit(tx, ctx, { action: "tax.preset_apply", entityType: "TaxRule", after: { preset: preset.id, created, skipped } }));
  return { created, skipped, title: preset.title };
}

export const presetsWithStatus = async (db: PrismaClient, ctx: Ctx) => {
  authorize(ctx, "tax.manage");
  const rules = await withTenant(db, ctx.tenantId, (tx) => tx.taxRule.findMany({ where: { tenantId: ctx.tenantId, status: { not: "RETIRED" } } }));
  return ACCOMMODATION_PRESETS.map((p) => ({
    ...p,
    applied: p.rules.filter((r) => rules.some((e) => e.category === r.category && iso(e.effectiveFrom) === r.effectiveFrom && minorOf(e.tariffMinMinor) === minorOf(r.tariffMinMinor) && minorOf(e.tariffMaxMinor) === minorOf(r.tariffMaxMinor) && e.rateBp === bp(r.ratePercent))).length,
  }));
};

const previewSchema = z.object({
  category: z.enum(CATEGORIES),
  tariffMinor: z.number().int().min(1).max(100_000_000),
  nights: z.number().int().min(1).max(30).default(1),
  inclusive: z.boolean().default(false),
  date: day,
  recipientStateCode: z.string().regex(/^\d{2}$/).optional(),
});

/**
 * "What would this charge?" for the setup wizard. Uses approved rules AND drafts (marked), so a hotel can test its
 * setup before anyone has approved it. Nothing is saved and no invoice is created.
 */
export async function previewTax(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "tax.manage");
  const propertyId = requireProperty(ctx);
  const d = previewSchema.parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [property, rows] = await Promise.all([
      tx.property.findFirstOrThrow({ where: { id: propertyId } }),
      tx.taxRule.findMany({ where: { tenantId: ctx.tenantId, status: { in: ["APPROVED", "DRAFT"] } } }),
    ]);
    const draftIds = new Set(rows.filter((r) => r.status === "DRAFT").map((r) => r.id));
    const rules: TaxRuleInput[] = rows.map((r) => ({
      id: r.id, category: r.category, sacCode: r.sacCode, treatment: r.treatment as TaxRuleInput["treatment"], rateBp: r.rateBp, cessBp: r.cessBp,
      tariffMinMinor: r.tariffMinMinor, tariffMaxMinor: r.tariffMaxMinor, placeOfSupply: r.placeOfSupply as TaxRuleInput["placeOfSupply"],
      effectiveFrom: iso(r.effectiveFrom), effectiveTo: r.effectiveTo ? iso(r.effectiveTo) : null, legalRef: r.legalRef, version: r.version, status: "APPROVED",
    }));
    const lines: { date: string; netMinor: number; taxMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; grossMinor: number; rateBp: number; draft: boolean; legalRef: string | null }[] = [];
    for (let i = 0; i < d.nights; i++) {
      const date = new Date(toDate(d.date).getTime() + i * 86_400_000).toISOString().slice(0, 10);
      try {
        const t = calculateTax({ amountMinor: d.tariffMinor, taxInclusive: d.inclusive, category: d.category, serviceDate: date, unitTariffMinor: d.tariffMinor }, { supplierRegistered: property.gstRegistered, supplierStateCode: property.gstStateCode, recipientStateCode: d.recipientStateCode ?? null }, rules);
        lines.push({ date, netMinor: t.netMinor, taxMinor: t.taxMinor, cgstMinor: t.detail.cgstMinor, sgstMinor: t.detail.sgstMinor, igstMinor: t.detail.igstMinor, grossMinor: t.grossMinor, rateBp: t.detail.rateBp, draft: !!t.detail.ruleId && draftIds.has(t.detail.ruleId), legalRef: t.detail.legalRef });
      } catch (e) {
        if (e instanceof TaxEngineError) return { error: e.message, lines, registered: property.gstRegistered };
        throw e;
      }
    }
    const sum = (k: "netMinor" | "taxMinor" | "grossMinor" | "cgstMinor" | "sgstMinor" | "igstMinor") => lines.reduce((t, l) => t + l[k], 0);
    return {
      error: null, registered: property.gstRegistered, lines, usesDraft: lines.some((l) => l.draft),
      totals: { netMinor: sum("netMinor"), taxMinor: sum("taxMinor"), grossMinor: sum("grossMinor"), cgstMinor: sum("cgstMinor"), sgstMinor: sum("sgstMinor"), igstMinor: sum("igstMinor") },
    };
  });
}

/** Where the GST setup stands: what is missing, whether accommodation is priced across every tariff, and who confirmed it. */
export async function gstSetupStatus(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "tax.manage");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [property, rules, st, invoices] = await Promise.all([
      tx.property.findFirstOrThrow({ where: { id: propertyId } }),
      tx.taxRule.findMany({ where: { tenantId: ctx.tenantId, status: { in: ["APPROVED", "DRAFT"] } } }),
      loadSettings(tx, ctx.tenantId, propertyId),
      tx.invoice.count({ where: { propertyId } }),
    ]);
    const today = dateInZone(new Date(), property.timezone);
    const approved: TaxRuleInput[] = rules.filter((r) => r.status === "APPROVED").map((r) => ({
      id: r.id, category: r.category, sacCode: r.sacCode, treatment: r.treatment as TaxRuleInput["treatment"], rateBp: r.rateBp, cessBp: r.cessBp,
      tariffMinMinor: r.tariffMinMinor, tariffMaxMinor: r.tariffMaxMinor, placeOfSupply: r.placeOfSupply as TaxRuleInput["placeOfSupply"],
      effectiveFrom: iso(r.effectiveFrom), effectiveTo: r.effectiveTo ? iso(r.effectiveTo) : null, legalRef: r.legalRef, version: r.version, status: "APPROVED",
    }));
    const covered = (tariff: number) => { try { selectRule(approved, { category: "ROOM", serviceDate: today, unitTariffMinor: tariff }); return true; } catch { return false; } };
    const sampleTariffs = [50_000, 200_000, 750_000, 750_001, 1_500_000];
    const missing: string[] = [];
    if (property.gstRegistered) {
      if (!property.gstin || !validateGstin(property.gstin).ok) missing.push("A valid GSTIN");
      if (!property.legalName) missing.push("The legal name");
      if (!property.address) missing.push("The registered address");
      if (!property.gstStateCode) missing.push("The GST state");
    }
    return {
      property: { gstRegistered: property.gstRegistered, gstin: property.gstin, legalName: property.legalName, address: property.address, gstStateCode: property.gstStateCode, invoicePrefix: property.invoicePrefix },
      today, invoicesIssued: invoices, missing,
      draftRules: rules.filter((r) => r.status === "DRAFT").length, approvedRules: approved.length,
      accommodation: sampleTariffs.map((t) => ({ tariffMinor: t, covered: covered(t) })),
      confirmedAt: st["tax.setupConfirmedAt"] || null, confirmedBy: st["tax.setupConfirmedBy"] || null,
    };
  });
}

/** The hotel records that its accountant has reviewed the setup. Refused while required details are missing. */
export async function confirmGstSetup(db: PrismaClient, ctx: Ctx, input: { reviewed: boolean }) {
  authorize(ctx, "tax.manage");
  authorize(ctx, "settings.manage");
  if (!input.reviewed) throw new AppError("VALIDATION", "Tick the box to confirm the setup was reviewed by the hotel's accountant or a qualified tax professional.");
  const s = await gstSetupStatus(db, ctx);
  if (s.missing.length) throw new AppError("VALIDATION", `Complete these first: ${s.missing.join(", ")}.`);
  const who = (await db.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? "Staff";
  await setSettings(db, ctx, { "tax.setupConfirmedAt": new Date().toISOString(), "tax.setupConfirmedBy": who });
  await withTenant(db, ctx.tenantId, (tx) => audit(tx, ctx, { action: "tax.setup_confirmed", entityType: "Property", entityId: ctx.propertyId ?? undefined, after: { by: who, approvedRules: s.approvedRules, draftRules: s.draftRules } }));
  return { by: who };
}

/** A short warning for billing screens: registered for GST but the setup is incomplete or was never confirmed. Null when all is well. */
export async function gstWarning(db: PrismaClient, ctx: Ctx): Promise<string | null> {
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [p, st] = await Promise.all([tx.property.findFirstOrThrow({ where: { id: propertyId } }), loadSettings(tx, ctx.tenantId, propertyId)]);
    if (!p.gstRegistered) return null;
    if (!p.gstin || !p.legalName || !p.address || !p.gstStateCode) return "GST registration details are incomplete (GSTIN, legal name, address or state), so tax invoices may be wrong.";
    if (!st["tax.setupConfirmedAt"]) return "The GST setup has not been confirmed by your accountant yet. Rates and tax invoices should not be relied on until it is.";
    return null;
  });
}
