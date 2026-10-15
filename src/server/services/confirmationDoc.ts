import { PDFDocument } from "pdf-lib";
import type { PrismaClient } from "@prisma/client";
import type { Ctx } from "@/server/auth/context";
import { resolveInvoiceStyle } from "@/server/domain/invoiceTheme";
import { renderConfirmationPdf } from "@/server/pdf/confirmation";
import { pdfMoney } from "@/server/pdf/invoice";
import { confirmationData } from "./confirmation";

/** The hotel's logo, when its link is a public https image of reasonable size. Any problem simply leaves the logo out. */
export async function fetchLogo(url: string | null | undefined): Promise<{ bytes: Uint8Array; type: "png" | "jpg" } | null> {
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

/** Joins several PDFs into one, in order. */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of parts) {
    const src = await PDFDocument.load(bytes);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return out.save();
}

/**
 * The confirmation as a PDF. A group booking produces one document with a section for every room and a group total on
 * each; `single` limits it to the one reservation. Used by the download and by the emailed attachment.
 */
export async function buildConfirmationDocument(db: PrismaClient, ctx: Ctx, id: string, opts: { single?: boolean } = {}) {
  const d = await confirmationData(db, ctx, id, opts);
  const st = d.settings;
  const logo = await fetchLogo(d.property.logoUrl || st["general.logoUrl"]);
  const style = resolveInvoiceStyle({ theme: st["billing.theme"], accent: st["billing.accentColor"], font: st["billing.font"] });
  const policies = ([["Cancellation policy", st["reservation.cancellationPolicy"]], ["No-show", st["reservation.noShowRule"]], ["Children", st["reservation.childPolicy"]], ["Booking policies", st["general.bookingPolicies"]]] as const)
    .filter(([, v]) => v).map(([title, body]) => ({ title, body: body as string }));
  const hotel = { name: d.property.legalName ?? d.property.name, address: d.property.address, gstin: d.property.gstin, phone: d.property.phone, email: d.property.email, checkInTime: d.property.checkInTime, checkOutTime: d.property.checkOutTime };
  const groupSummary = d.group
    ? `Group booking ${d.group.ref}: ${d.group.rooms} rooms. Group total ${pdfMoney(d.group.totalMinor)}${d.group.paidMinor !== null ? `, advance ${pdfMoney(d.group.paidMinor)}, balance ${pdfMoney(Math.max(0, d.group.totalMinor - d.group.paidMinor))}` : ""}.`
    : null;
  const parts: Uint8Array[] = [];
  for (const it of d.items) {
    parts.push(await renderConfirmationPdf({
      hotel, logo, headerText: st["reservation.confirmationHeader"], footerText: st["reservation.confirmationFooter"], groupSummary,
      references: [it.reservation.reference], status: it.reservation.status, guest: it.guest, arrival: it.arrival, departure: it.departure, nights: it.nights,
      adults: it.adults, children: it.children, category: it.category, room: it.room, nightly: it.nightly, subtotalMinor: it.subtotalMinor, taxMinor: it.taxMinor,
      totalMinor: it.totalMinor, paidMinor: it.paidMinor, taxNote: it.taxNote, policies, style,
    }));
  }
  const bytes = parts.length === 1 ? parts[0] : await mergePdfs(parts);
  return {
    bytes, rooms: d.items.length, reference: d.reservation.reference, groupRef: d.group?.ref ?? null,
    guest: d.guest, hotelName: d.property.name, arrival: d.arrival, departure: d.departure,
    filename: `confirmation-${(d.group?.ref ?? d.reservation.reference).replace(/[^\w.-]/g, "-")}.pdf`,
  };
}
