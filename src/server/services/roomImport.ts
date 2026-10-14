import ExcelJS from "exceljs";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { audit } from "./audit";

export const IMPORT_HEADERS = ["room_number", "category", "building", "floor"] as const;
export const MAX_IMPORT_ROWS = 1000;
export const TEMPLATE_CSV = `${IMPORT_HEADERS.join(",")}\r\n101,Deluxe,Main Building,Floor 1\r\n102,Deluxe,Main Building,Floor 1\r\n`;

export type ImportRow = { line: number; number: string; category: string; building: string; floor: string };
export type RowError = { line: number; message: string };
export type ImportPreview = { rows: ImportRow[]; errors: RowError[] };

/** Minimal RFC 4180 parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) out.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) out.push(row);
  return out;
}

export async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError("VALIDATION", "The workbook has no sheets.");
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells: string[] = [];
    for (let c = 1; c <= IMPORT_HEADERS.length; c++) {
      const v = r.getCell(c).value;
      cells.push(v === null || v === undefined ? "" : typeof v === "object" ? String((v as { text?: unknown; result?: unknown }).text ?? (v as { result?: unknown }).result ?? "") : String(v));
    }
    if (cells.some((x) => x.trim() !== "")) out.push(cells);
  });
  return out;
}

/** Pure: turns a grid (first row = headers) into validated rows. Database checks happen in previewImport. */
export function gridToRows(grid: string[][]): ImportPreview {
  const errors: RowError[] = [];
  if (grid.length === 0) throw new AppError("VALIDATION", "The file is empty.");
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(IMPORT_HEADERS.map((h) => [h, header.indexOf(h)])) as Record<(typeof IMPORT_HEADERS)[number], number>;
  const missing = IMPORT_HEADERS.filter((h) => idx[h] < 0 && h !== "building" && h !== "floor");
  if (missing.length) throw new AppError("VALIDATION", `Missing column(s): ${missing.join(", ")}. Download the template for the expected layout.`);
  if (grid.length - 1 > MAX_IMPORT_ROWS) throw new AppError("VALIDATION", `Too many rows (maximum ${MAX_IMPORT_ROWS}).`);
  const rows: ImportRow[] = [];
  const seen = new Map<string, number>();
  grid.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (h: (typeof IMPORT_HEADERS)[number]) => (idx[h] >= 0 ? (r[idx[h]] ?? "").trim() : "");
    const row: ImportRow = { line, number: get("room_number"), category: get("category"), building: get("building"), floor: get("floor") };
    if (!row.number) errors.push({ line, message: "Room number is required." });
    else if (row.number.length > 20) errors.push({ line, message: "Room number is longer than 20 characters." });
    else if (seen.has(row.number.toLowerCase())) errors.push({ line, message: `Room ${row.number} is repeated (first on line ${seen.get(row.number.toLowerCase())}).` });
    else seen.set(row.number.toLowerCase(), line);
    if (!row.category) errors.push({ line, message: "Category is required." });
    if (row.floor && !row.building) errors.push({ line, message: "A floor needs a building." });
    rows.push(row);
  });
  return { rows, errors };
}

/** Checks rows against the database (categories, floors, existing room numbers). Writes nothing. */
export async function previewImport(db: PrismaClient, ctx: Ctx, grid: string[][]): Promise<ImportPreview> {
  authorize(ctx, "rooms.manage");
  const propertyId = requireProperty(ctx);
  const { rows, errors } = gridToRows(grid);
  await withTenant(db, ctx.tenantId, async (tx) => {
    const [types, floors, existing] = await Promise.all([
      tx.roomType.findMany({ where: { propertyId } }),
      tx.floor.findMany({ where: { propertyId }, include: { building: true } }),
      tx.room.findMany({ where: { propertyId }, select: { number: true } }),
    ]);
    const typeNames = new Set(types.map((t) => t.name.toLowerCase()));
    const floorKeys = new Map(floors.map((f) => [`${f.building.name.toLowerCase()}|${f.label.toLowerCase()}`, f]));
    const have = new Set(existing.map((r) => r.number.toLowerCase()));
    for (const r of rows) {
      if (r.number && have.has(r.number.toLowerCase())) errors.push({ line: r.line, message: `Room ${r.number} already exists.` });
      if (r.category && !typeNames.has(r.category.toLowerCase())) errors.push({ line: r.line, message: `Unknown category "${r.category}".` });
      if (r.building) {
        const f = floorKeys.get(`${r.building.toLowerCase()}|${r.floor.toLowerCase()}`);
        if (r.floor && !f) errors.push({ line: r.line, message: `Floor "${r.floor}" not found in "${r.building}".` });
        else if (f && !f.active) errors.push({ line: r.line, message: `Floor "${r.floor}" is inactive.` });
      }
    }
  });
  errors.sort((a, b) => a.line - b.line);
  return { rows, errors };
}

/** All-or-nothing: re-validates, then creates every room in one transaction. */
export async function commitImport(db: PrismaClient, ctx: Ctx, grid: string[][]) {
  const preview = await previewImport(db, ctx, grid);
  if (preview.errors.length) throw new AppError("VALIDATION", `Fix ${preview.errors.length} error(s) before importing.`);
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const types = await tx.roomType.findMany({ where: { propertyId } });
    const floors = await tx.floor.findMany({ where: { propertyId }, include: { building: true } });
    for (const r of preview.rows) {
      const type = types.find((t) => t.name.toLowerCase() === r.category.toLowerCase())!;
      const f = r.floor ? floors.find((x) => x.building.name.toLowerCase() === r.building.toLowerCase() && x.label.toLowerCase() === r.floor.toLowerCase()) : undefined;
      await tx.room.create({
        data: {
          tenantId: ctx.tenantId, propertyId, roomTypeId: type.id, number: r.number,
          ...(f && { floorId: f.id, buildingId: f.buildingId, floor: f.level }),
        },
      });
    }
    await audit(tx, ctx, { action: "room.import", entityType: "Room", entityId: propertyId, after: { count: preview.rows.length } });
    return { created: preview.rows.length };
  });
}
