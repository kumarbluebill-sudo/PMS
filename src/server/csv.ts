/** One CSV cell: quoted, and neutralised against spreadsheet formula injection (a leading = + - @ is escaped). */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export const csvHeaders = (filename: string) => ({
  "content-type": "text/csv; charset=utf-8",
  "content-disposition": `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
  "cache-control": "no-store",
});
