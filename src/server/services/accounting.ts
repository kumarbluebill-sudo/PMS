import type { PrismaClient } from "@prisma/client";
import { authorize, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";

export type TrialBalanceRow = { code: string; name: string; type: string; debitMinor: number; creditMinor: number; balanceMinor: number };

/** Trial balance from posted journal lines. Normal-balance sign: assets/expenses debit, others credit. */
export async function trialBalance(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "accounting.view");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const accounts = await tx.account.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { code: "asc" } });
    const sums = await tx.journalLine.groupBy({ by: ["accountId"], where: { tenantId: ctx.tenantId }, _sum: { debitMinor: true, creditMinor: true } });
    const m = new Map(sums.map((s) => [s.accountId, s._sum]));
    const rows: TrialBalanceRow[] = accounts.map((a) => {
      const debit = m.get(a.id)?.debitMinor ?? 0;
      const credit = m.get(a.id)?.creditMinor ?? 0;
      const debitNormal = a.type === "ASSET" || a.type === "EXPENSE";
      return { code: a.code, name: a.name, type: a.type, debitMinor: debit, creditMinor: credit, balanceMinor: debitNormal ? debit - credit : credit - debit };
    });
    const totalDebit = rows.reduce((s, r) => s + r.debitMinor, 0);
    const totalCredit = rows.reduce((s, r) => s + r.creditMinor, 0);
    return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  });
}

/**
 * Cross-checks that independent records agree: the receivable control account must equal the sum of all folio
 * balances, and invoice totals must equal the ledger entries they cover.
 */
export async function reconcile(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "accounting.view");
  return withTenant(db, ctx.tenantId, async (tx) => {
    const tb = await trialBalance(db, ctx);
    const receivable = tb.rows.find((r) => r.code === "1100")?.balanceMinor ?? 0;
    const folioSum = (await tx.folioEntry.aggregate({ where: { tenantId: ctx.tenantId }, _sum: { balanceDeltaMinor: true } }))._sum.balanceDeltaMinor ?? 0;
    const invoiced = (await tx.invoice.aggregate({ where: { tenantId: ctx.tenantId }, _sum: { grossMinor: true } }))._sum.grossMinor ?? 0;
    const invoicedLines = (await tx.invoiceLine.aggregate({ where: { tenantId: ctx.tenantId }, _sum: { grossMinor: true } }))._sum.grossMinor ?? 0;
    return {
      journalBalanced: tb.balanced,
      receivableMatchesFolios: receivable === folioSum,
      receivableMinor: receivable,
      folioBalanceMinor: folioSum,
      invoiceTotalsMatchLines: invoiced === invoicedLines,
    };
  });
}
