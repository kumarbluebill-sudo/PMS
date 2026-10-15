import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { exportAllData } from "@/server/services/dataExport";

/** A full Excel export of the hotel's data. Works in read-only mode: a lapsed subscription never locks anyone out of their data. */
export async function GET() {
  const ctx = await getCtx();
  const { bytes } = await exportAllData(getDb(), ctx);
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="hotel-data-${stamp}.xlsx"`,
      "cache-control": "private, no-store",
    },
  });
}
