import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { resolveInvoiceStyle } from "@/server/domain/invoiceTheme";
import { renderConfirmationPdf } from "@/server/pdf/confirmation";
import { getCtx } from "@/server/session";
import { confirmationData } from "@/server/services/confirmation";

/** The hotel's logo, when its link is a public https image of reasonable size. Any problem simply leaves the logo out. */
async function fetchLogo(url: string | null | undefined): Promise<{ bytes: Uint8Array; type: "png" | "jpg" } | null> {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // Public hosts only: no IP addresses, local names or internal domains.
    if (u.protocol !== "https:" || /^[\d.:[\]]+$/.test(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(3000), redirect: "error" });
    const type = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (!res.ok || !(type.includes("png") || type.includes("jpeg") || type.includes("jpg"))) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 400_000) return null;
    return { bytes: buf, type: type.includes("png") ? "png" : "jpg" };
  } catch {
    return null;
  }
}

/** Downloadable booking confirmation (reservation access required; money only for staff with billing access). */
export async function GET(_req: NextRequest, { params }: RouteContext<"/app/reservations/[id]/confirmation/pdf">) {
  const { id } = await params;
  const ctx = await getCtx();
  const d = await confirmationData(getDb(), ctx, id);
  const st = d.settings;
  const bytes = await renderConfirmationPdf({
    hotel: { name: d.property.legalName ?? d.property.name, address: d.property.address, gstin: d.property.gstin, phone: d.property.phone, email: d.property.email, checkInTime: d.property.checkInTime, checkOutTime: d.property.checkOutTime },
    logo: await fetchLogo(d.property.logoUrl || st["general.logoUrl"]),
    headerText: st["reservation.confirmationHeader"], footerText: st["reservation.confirmationFooter"],
    references: [d.reservation.reference], status: d.reservation.status, guest: d.guest, arrival: d.arrival, departure: d.departure, nights: d.nights,
    adults: d.adults, children: d.children, category: d.category, room: d.room, nightly: d.nightly, subtotalMinor: d.subtotalMinor, taxMinor: d.taxMinor,
    totalMinor: d.totalMinor, paidMinor: d.paidMinor, taxNote: d.taxNote,
    policies: ([["Cancellation policy", st["reservation.cancellationPolicy"]], ["No-show", st["reservation.noShowRule"]], ["Children", st["reservation.childPolicy"]], ["Booking policies", st["general.bookingPolicies"]]] as const)
      .filter(([, v]) => v).map(([title, body]) => ({ title, body: body as string })),
    style: resolveInvoiceStyle({ theme: st["billing.theme"], accent: st["billing.accentColor"], font: st["billing.font"] }),
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="confirmation-${d.reservation.reference.replace(/[^\w.-]/g, "-")}.pdf"`, "cache-control": "private, no-store" },
  });
}
