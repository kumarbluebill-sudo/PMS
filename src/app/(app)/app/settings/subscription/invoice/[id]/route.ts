import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { renderSubscriptionInvoicePdf } from "@/server/pdf/subscriptionInvoice";
import { getCtx } from "@/server/session";
import { getSubscriptionInvoice } from "@/server/services/subscription";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The subscription invoice PDF. Only people who may view settings in the hotel it was issued to can download it. */
export async function GET(_req: NextRequest, { params }: RouteContext<"/app/settings/subscription/invoice/[id]">) {
  const { id } = await params;
  const ctx = await getCtx();
  const { inv, settings, customer } = await getSubscriptionInvoice(getDb(), ctx, id);
  const paid = await withTenant(getDb(), ctx.tenantId, (tx) => tx.subscriptionPayment.aggregate({ where: { invoiceId: inv.id, status: "SUCCEEDED" }, _sum: { amountMinor: true } }));
  const bytes = await renderSubscriptionInvoicePdf({
    number: inv.number, issuedDate: iso(inv.issuedAt), dueDate: iso(inv.dueDate), status: inv.status,
    seller: { name: settings["saas.legalName"], gstin: settings["saas.gstin"], address: settings["saas.address"], sacCode: settings["saas.sacCode"] },
    customer, lines: (inv.lines as { description: string; amountMinor: number }[]) ?? [],
    netMinor: inv.netMinor, taxBps: inv.taxBps, taxMinor: inv.taxMinor, grossMinor: inv.grossMinor, paidMinor: paid._sum.amountMinor ?? 0,
    paymentInstructions: settings["saas.paymentInstructions"],
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${inv.number.replaceAll("/", "-")}.pdf"`, "cache-control": "private, no-store" },
  });
}
