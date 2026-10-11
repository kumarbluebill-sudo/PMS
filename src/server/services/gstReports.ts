import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import type { TaxDetail } from "@/server/domain/gst";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export type GstSummaryRow = {
  sacCode: string;
  rateBp: number;
  cessBp: number;
  treatment: string;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  cessMinor: number;
  grossMinor: number;
  lines: number;
};

export type RegisterRow = {
  number: string;
  date: string;
  kind: string;
  originalNumber: string | null;
  recipient: string;
  recipientGstin: string;
  placeOfSupply: string;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  cessMinor: number;
  grossMinor: number;
};

/**
 * GST summary and invoice register for a date range, built only from issued documents. Credit notes carry negative
 * amounts and debit notes positive ones, so the totals are net of corrections. This is an aid for the accountant,
 * not a GSTR return.
 */
export async function gstSummary(db: PrismaClient, ctx: Ctx, input: { from: string; to: string }) {
  authorize(ctx, "accounting.view");
  const propertyId = requireProperty(ctx);
  const f = z.object({ from: day, to: day }).refine((d) => d.to >= d.from, { message: "The end date cannot be before the start date." }).parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const invoices = await tx.invoice.findMany({
      where: {
        propertyId,
        issuedAt: { gte: new Date(`${f.from}T00:00:00.000Z`), lt: new Date(new Date(`${f.to}T00:00:00.000Z`).getTime() + 86_400_000) },
      },
      include: { lines: true },
      orderBy: { issuedAt: "asc" },
    });
    const originals = await tx.invoice.findMany({
      where: { id: { in: invoices.map((i) => i.originalInvoiceId).filter((x): x is string => !!x) } },
      select: { id: true, number: true },
    });
    const origNo = new Map(originals.map((o) => [o.id, o.number]));

    const groups = new Map<string, GstSummaryRow>();
    for (const inv of invoices) {
      for (const l of inv.lines) {
        const d = (l.taxDetail ?? {}) as Partial<TaxDetail>;
        const key = `${l.sacCode ?? ""}|${d.rateBp ?? 0}|${d.cessBp ?? 0}|${d.treatment ?? "NONE"}`;
        const g = groups.get(key) ?? {
          sacCode: l.sacCode ?? "", rateBp: d.rateBp ?? 0, cessBp: d.cessBp ?? 0, treatment: d.treatment ?? "NONE",
          taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, cessMinor: 0, grossMinor: 0, lines: 0,
        };
        g.taxableMinor += l.netMinor; g.cgstMinor += l.cgstMinor; g.sgstMinor += l.sgstMinor; g.igstMinor += l.igstMinor;
        g.cessMinor += l.cessMinor; g.grossMinor += l.grossMinor; g.lines += 1;
        groups.set(key, g);
      }
    }
    const rows = [...groups.values()].sort((a, b) => a.sacCode.localeCompare(b.sacCode) || a.rateBp - b.rateBp);
    const sum = (k: keyof Pick<GstSummaryRow, "taxableMinor" | "cgstMinor" | "sgstMinor" | "igstMinor" | "cessMinor" | "grossMinor">) =>
      rows.reduce((t, r) => t + r[k], 0);
    const register: RegisterRow[] = invoices.map((inv) => {
      const r = (inv.recipient ?? {}) as { name?: string; gstin?: string };
      return {
        number: inv.number, date: iso(inv.issuedAt), kind: inv.kind, originalNumber: inv.originalInvoiceId ? (origNo.get(inv.originalInvoiceId) ?? null) : null,
        recipient: r.name ?? "", recipientGstin: r.gstin ?? "", placeOfSupply: inv.placeOfSupply ?? "",
        taxableMinor: inv.netMinor, cgstMinor: inv.cgstMinor, sgstMinor: inv.sgstMinor, igstMinor: inv.igstMinor,
        cessMinor: inv.cessMinor, grossMinor: inv.grossMinor,
      };
    });
    return {
      from: f.from, to: f.to, rows, register,
      totals: { taxableMinor: sum("taxableMinor"), cgstMinor: sum("cgstMinor"), sgstMinor: sum("sgstMinor"), igstMinor: sum("igstMinor"), cessMinor: sum("cessMinor"), grossMinor: sum("grossMinor") },
    };
  });
}
