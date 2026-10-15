import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { buildConfirmationDocument } from "@/server/services/confirmationDoc";

/**
 * Downloadable booking confirmation (reservation access required; money only for staff with billing access).
 * A group booking downloads every room together; add ?single=1 for just this reservation.
 */
export async function GET(req: NextRequest, { params }: RouteContext<"/app/reservations/[id]/confirmation/pdf">) {
  const { id } = await params;
  const ctx = await getCtx();
  const doc = await buildConfirmationDocument(getDb(), ctx, id, { single: req.nextUrl.searchParams.get("single") === "1" });
  return new NextResponse(Buffer.from(doc.bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${doc.filename}"`, "cache-control": "private, no-store" },
  });
}
