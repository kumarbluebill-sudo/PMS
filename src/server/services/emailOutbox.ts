import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import {
  advanceStatus, emailConfig, isEmail, sendViaResend, statusFromEvent, type EmailAttachment, type EmailConfig, type EmailMessage, type EmailResult, type EmailStatus,
} from "@/server/messaging/email";
import { audit } from "./audit";

export const emailStatus = () => ({ configured: emailConfig() !== null, mode: emailConfig() ? ("LIVE" as const) : ("TEST" as const) });

type Sender = (cfg: EmailConfig, m: EmailMessage) => Promise<EmailResult>;

export type OutgoingEmail = {
  tenantId?: string | null;
  reservationId?: string | null;
  kind: "ACCOUNT" | "CONFIRMATION";
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  /** The same key never sends twice. */
  idempotencyKey?: string;
};

/**
 * Records an email and tries to send it now. Never throws for a provider problem: the row says what happened.
 * No provider configured: TEST (nothing was sent). Provider took it: ACCEPTED (not "delivered"; only the signed
 * webhook can say delivered or bounced). Provider refused or unreachable: FAILED with the reason.
 */
export async function deliverEmail(db: PrismaClient, e: OutgoingEmail, send: Sender = sendViaResend, cfg: EmailConfig | null = emailConfig()) {
  if (e.idempotencyKey) {
    const dup = await db.emailOutbox.findFirst({ where: { idempotencyKey: e.idempotencyKey } });
    if (dup) return { row: dup, duplicate: true };
  }
  let row;
  try {
    row = await db.emailOutbox.create({
      data: { toEmail: e.to, subject: e.subject, body: e.text, kind: e.kind, tenantId: e.tenantId ?? null, reservationId: e.reservationId ?? null, idempotencyKey: e.idempotencyKey ?? null, status: "QUEUED" },
    });
  } catch (err) {
    // Two sends with the same key at once: the second sees the first.
    const again = e.idempotencyKey ? await db.emailOutbox.findFirst({ where: { idempotencyKey: e.idempotencyKey } }) : null;
    if (again) return { row: again, duplicate: true };
    throw err;
  }
  if (!cfg) return { row: await db.emailOutbox.update({ where: { id: row.id }, data: { status: "TEST", provider: "none" } }), duplicate: false };
  const r = await send(cfg, { to: e.to, subject: e.subject, text: e.text, html: e.html, attachments: e.attachments, idempotencyKey: row.id });
  const updated = await db.emailOutbox.update({
    where: { id: row.id },
    data: r.ok ? { status: "ACCEPTED", provider: "resend", providerId: r.id, sentAt: new Date() } : { status: "FAILED", provider: "resend", error: r.error },
  });
  return { row: updated, duplicate: false };
}

/** A provider event (from the verified webhook) for a message we sent. Unknown ids and unknown events are ignored. */
export async function applyEmailEvent(db: PrismaClient, providerId: string, eventType: string) {
  const incoming = statusFromEvent(eventType);
  if (!incoming || !providerId) return 0;
  const rows = await db.emailOutbox.findMany({ where: { providerId } });
  let n = 0;
  for (const r of rows) {
    const next = advanceStatus(r.status as EmailStatus, incoming);
    if (next === r.status) continue;
    await db.emailOutbox.update({
      where: { id: r.id },
      data: { status: next, ...(next === "DELIVERED" ? { deliveredAt: new Date() } : {}), ...(next === "BOUNCED" ? { error: eventType === "email.complained" ? "The recipient marked it as spam." : "The address bounced." } : {}), ...(next === "FAILED" ? { error: "The provider reported a failure." } : {}) },
    });
    n++;
  }
  return n;
}

/** Emails sent about one reservation, for the log beside the send button. */
export async function listReservationEmails(db: PrismaClient, ctx: Ctx, reservationId: string) {
  authorize(ctx, "reservations.view");
  return db.emailOutbox.findMany({
    where: { tenantId: ctx.tenantId, reservationId, kind: "CONFIRMATION" }, orderBy: { createdAt: "desc" }, take: 10,
    select: { id: true, toEmail: true, subject: true, status: true, error: true, createdAt: true, sentAt: true, deliveredAt: true },
  });
}

const maskEmail = (s: string) => { const [u, h] = s.split("@"); return `${u.slice(0, 1)}…@${h}`; };

/**
 * Emails the booking confirmation (with the PDF attached) to the guest. Needs the guest's email consent, a valid
 * address, and `guests.manage`. Sending the same confirmation twice returns the first record unless a new `nonce` is given.
 */
export async function sendConfirmationEmail(db: PrismaClient, ctx: Ctx, input: { reservationId: string; nonce?: string }, send: Sender = sendViaResend, cfg: EmailConfig | null = emailConfig()) {
  authorize(ctx, "guests.manage");
  const propertyId = requireProperty(ctx);
  const info = await withTenant(db, ctx.tenantId, async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: input.reservationId, propertyId }, include: { guest: true } });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    const consent = await tx.guestConsent.findUnique({ where: { guestId_channel: { guestId: r.guestId, channel: "EMAIL" } } });
    if (consent?.status !== "GRANTED") throw new AppError("FORBIDDEN", "This guest has not agreed to receive email. Record consent first.");
    if (!isEmail(r.guest.email)) throw new AppError("VALIDATION", "The guest has no valid email address.");
    return { email: r.guest.email, guestId: r.guestId };
  });
  const key = `confirmation:${input.reservationId}${input.nonce ? `:${input.nonce}` : ""}`;
  const existing = await db.emailOutbox.findFirst({ where: { idempotencyKey: key } });
  if (existing) return { row: existing, duplicate: true };
  // Loaded on demand so sign-in and sign-up do not pull in the PDF code.
  const { buildConfirmationDocument } = await import("./confirmationDoc");
  const doc = await buildConfirmationDocument(db, ctx, input.reservationId);
  const first = doc.guest.name.split(" ")[0];
  const text = `Dear ${first},\n\nThank you for booking with ${doc.hotelName}. Your confirmation for ${doc.groupRef ? `group booking ${doc.groupRef}` : `reservation ${doc.reference}`} is attached.\nArrival: ${doc.arrival}\nDeparture: ${doc.departure}\n\nPlease carry a valid photo ID. If anything needs changing, reply to this email or call the hotel.\n\n${doc.hotelName}`;
  const out = await deliverEmail(db, { tenantId: ctx.tenantId, reservationId: input.reservationId, kind: "CONFIRMATION", to: info.email, subject: `Your booking confirmation: ${doc.hotelName}`, text, attachments: [{ filename: doc.filename, content: doc.bytes }], idempotencyKey: key }, send, cfg);
  await withTenant(db, ctx.tenantId, (tx) => audit(tx, ctx, { action: "email.confirmation", entityType: "Reservation", entityId: input.reservationId, after: { to: maskEmail(info.email), status: out.row.status } }));
  return out;
}
