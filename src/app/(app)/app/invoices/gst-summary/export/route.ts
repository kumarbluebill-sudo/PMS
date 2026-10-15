import ExcelJS from "exceljs";
import { NextResponse, type NextRequest } from "next/server";
import { csvHeaders, toCsv } from "@/server/csv";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { gstSummary } from "@/server/services/gstReports";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const rupees = (m: number) => (m / 100).toFixed(2);
const pct = (bp: number) => (bp / 100).toFixed(2);

export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  const p = req.nextUrl.searchParams;
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  if (!DAY.test(from) || !DAY.test(to)) return new NextResponse("Invalid dates", { status: 400 });
  let data;
  try {
    data = await gstSummary(getDb(), ctx, { from, to });
  } catch (e) {
    const forbidden = e instanceof Error && e.name === "ForbiddenError";
    return new NextResponse(forbidden ? "Forbidden" : "Could not build the export", { status: forbidden ? 403 : 400 });
  }
  if (p.get("format") === "xlsx") {
    const wb = new ExcelJS.Workbook();
    const inr = (n: number) => n / 100;
    const sum = wb.addWorksheet("SAC-wise summary");
    sum.addRow(["SAC", "Rate %", "Cess %", "Treatment", "Taxable (INR)", "CGST (INR)", "SGST (INR)", "IGST (INR)", "Cess (INR)", "Total (INR)", "Lines"]);
    for (const r of data.rows) sum.addRow([r.sacCode, r.rateBp / 100, r.cessBp / 100, r.treatment, inr(r.taxableMinor), inr(r.cgstMinor), inr(r.sgstMinor), inr(r.igstMinor), inr(r.cessMinor), inr(r.grossMinor), r.lines]);
    const reg = wb.addWorksheet("Invoice register");
    reg.addRow(["Number", "Date", "Type", "Original document", "Recipient", "Recipient GSTIN", "Place of supply", "Taxable (INR)", "CGST (INR)", "SGST (INR)", "IGST (INR)", "Cess (INR)", "Total (INR)"]);
    for (const r of data.register) reg.addRow([r.number, r.date, r.kind, r.originalNumber, r.recipient, r.recipientGstin, r.placeOfSupply, inr(r.taxableMinor), inr(r.cgstMinor), inr(r.sgstMinor), inr(r.igstMinor), inr(r.cessMinor), inr(r.grossMinor)]);
    for (const ws of [sum, reg]) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.columns.forEach((c) => { c.width = 16; });
      ws.eachRow((row, i) => { if (i > 1) row.eachCell((cell) => { if (typeof cell.value === "number") cell.numFmt = "#,##0.00"; }); });
    }
    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(Buffer.from(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="gst-${from}-to-${to}.xlsx"`,
        "cache-control": "private, no-store",
      },
    });
  }
  const body =
    p.get("kind") === "register"
      ? toCsv(
          ["Number", "Date", "Type", "Original document", "Recipient", "Recipient GSTIN", "Place of supply", "Taxable (INR)", "CGST (INR)", "SGST (INR)", "IGST (INR)", "Cess (INR)", "Total (INR)"],
          data.register.map((r) => [r.number, r.date, r.kind, r.originalNumber, r.recipient, r.recipientGstin, r.placeOfSupply, rupees(r.taxableMinor), rupees(r.cgstMinor), rupees(r.sgstMinor), rupees(r.igstMinor), rupees(r.cessMinor), rupees(r.grossMinor)]),
        )
      : toCsv(
          ["SAC", "Rate %", "Cess %", "Treatment", "Taxable (INR)", "CGST (INR)", "SGST (INR)", "IGST (INR)", "Cess (INR)", "Total (INR)", "Lines"],
          data.rows.map((r) => [r.sacCode, pct(r.rateBp), pct(r.cessBp), r.treatment, rupees(r.taxableMinor), rupees(r.cgstMinor), rupees(r.sgstMinor), rupees(r.igstMinor), rupees(r.cessMinor), rupees(r.grossMinor), r.lines]),
        );
  return new NextResponse(body, { headers: csvHeaders(`gst-${p.get("kind") === "register" ? "register" : "summary"}-${from}-to-${to}.csv`) });
}
