import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { GST_STATES, validateGstin } from "@/server/domain/gst";
import { audit } from "./audit";
import { CATEGORIES } from "./billing";

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
