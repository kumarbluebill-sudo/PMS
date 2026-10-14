import { NextResponse } from "next/server";
import { roleHasPermission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";
import { TEMPLATE_CSV } from "@/server/services/roomImport";

export async function GET() {
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "rooms.manage", ctx.extra)) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(TEMPLATE_CSV, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="rooms-template.csv"' },
  });
}
