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
