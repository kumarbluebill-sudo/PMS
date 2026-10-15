import ExcelJS from "exceljs";
import type { PrismaClient } from "@prisma/client";
import { authorize, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { audit } from "./audit";

type Row = Record<string, unknown>;
const HIDDEN = new Set(["idNumberEnc", "tenantId"]);

/** Dates as ISO text, JSON as text, money columns left in paise (named *Minor) so nothing is rounded. */
function cell(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "bigint") return Number(v);
  return v as string | number | boolean;
}

function sheet(wb: ExcelJS.Workbook, name: string, rows: Row[]) {
  const ws = wb.addWorksheet(name);
  const keys = rows.length ? Object.keys(rows[0]).filter((k) => !HIDDEN.has(k)) : [];
  ws.addRow(keys.length ? keys : ["(no rows)"]).font = { bold: true };
  for (const r of rows) ws.addRow(keys.map((k) => cell(r[k])));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.columns.forEach((c) => { c.width = 18; });
}

/**
 * Everything a hotel owns, in one workbook: reservations, guests, folios and their postings, payments, invoices, rooms.
 * Always available, including when a subscription has lapsed. Government ID numbers are not included. The export is
 * recorded in the audit log.
 */
export async function exportAllData(db: PrismaClient, ctx: Ctx): Promise<{ bytes: Uint8Array; counts: Record<string, number> }> {
  authorize(ctx, "reports.export");
  const t = ctx.tenantId;
  const data = await withTenant(db, t, async (tx) => ({
    Properties: await tx.property.findMany({ where: { tenantId: t } }),
    Rooms: await tx.room.findMany({ where: { tenantId: t } }),
    Categories: await tx.roomType.findMany({ where: { tenantId: t } }),
    Guests: await tx.guest.findMany({ where: { tenantId: t } }),
    Reservations: await tx.reservation.findMany({ where: { tenantId: t } }),
    Folios: await tx.folio.findMany({ where: { tenantId: t } }),
    FolioEntries: await tx.folioEntry.findMany({ where: { tenantId: t } }),
    Payments: await tx.payment.findMany({ where: { tenantId: t } }),
    Invoices: await tx.invoice.findMany({ where: { tenantId: t } }),
  }));
  const wb = new ExcelJS.Workbook();
  wb.creator = "MK Hotel PMS";
  wb.created = new Date();
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(data)) {
    counts[name] = rows.length;
    sheet(wb, name, rows as unknown as Row[]);
  }
  await withTenant(db, t, (tx) => audit(tx, ctx, { action: "data.export_all", entityType: "Tenant", entityId: t, after: counts }));
  return { bytes: new Uint8Array(await wb.xlsx.writeBuffer()), counts };
}
