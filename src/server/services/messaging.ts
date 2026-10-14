import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorize, requireProperty, type Ctx } from "@/server/auth/context";
import { withTenant } from "@/server/db/withTenant";
import { AppError } from "@/server/errors";
import { formatInr } from "@/server/money";
import { maskPhone, toE164 } from "@/server/messaging/phone";
import { getDriver, mapTwilioStatus, twilioConfig, type MessageDriver } from "@/server/messaging/provider";
import { DEFAULT_BODIES, renderTemplate, TEMPLATE_KEYS, type TemplateKey } from "@/server/messaging/templates";
import { audit } from "./audit";
import { folioBalance } from "./billing";

const day = (d: Date) => d.toISOString().slice(0, 10);
const keySchema = z.enum(TEMPLATE_KEYS);

export const messagingStatus = () => ({ configured: twilioConfig() !== null, mode: twilioConfig() ? ("LIVE" as const) : ("TEST" as const) });

// ---------- consent ----------

export async function setConsent(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "guests.manage");
  const d = z.object({ guestId: z.string().uuid(), status: z.enum(["GRANTED", "REVOKED"]), source: z.string().trim().min(2, "Say how consent was given.").max(120) }).parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const guest = await tx.guest.findFirst({ where: { id: d.guestId } });
    if (!guest) throw new AppError("NOT_FOUND", "Guest not found.");
    const row = await tx.guestConsent.upsert({
      where: { guestId_channel: { guestId: d.guestId, channel: "WHATSAPP" } },
      create: { tenantId: ctx.tenantId, guestId: d.guestId, status: d.status, source: d.source, recordedBy: ctx.userId },
      update: { status: d.status, source: d.source, recordedBy: ctx.userId, at: new Date() },
    });
    await audit(tx, ctx, { action: `consent.whatsapp.${d.status.toLowerCase()}`, entityType: "Guest", entityId: d.guestId, after: { source: d.source } });
    return row;
  });
}

export async function getConsent(db: PrismaClient, ctx: Ctx, guestId: string) {
  authorize(ctx, "guests.view");
  return withTenant(db, ctx.tenantId, (tx) => tx.guestConsent.findUnique({ where: { guestId_channel: { guestId, channel: "WHATSAPP" } } }));
}

// ---------- templates ----------

export async function listTemplates(db: PrismaClient, ctx: Ctx) {
  authorize(ctx, "settings.view");
  const propertyId = requireProperty(ctx);
  const saved = await withTenant(db, ctx.tenantId, (tx) => tx.messageTemplate.findMany({ where: { propertyId } }));
  return TEMPLATE_KEYS.map((key) => {
    const s = saved.find((t) => t.key === key);
    return { key, body: s?.body ?? DEFAULT_BODIES[key], contentSid: s?.contentSid ?? "", active: s?.active ?? true, customised: !!s };
  });
}

export async function saveTemplate(db: PrismaClient, ctx: Ctx, input: unknown) {
  authorize(ctx, "settings.manage");
  const propertyId = requireProperty(ctx);
  const d = z
    .object({
      key: keySchema,
      body: z.string().trim().min(5, "Enter the message text.").max(1000),
      contentSid: z.string().trim().max(64).regex(/^(HX[0-9a-f]{32})?$/i, "A Twilio Content SID looks like HX followed by 32 characters.").default(""),
      active: z.boolean().default(true),
    })
    .parse(input);
  return withTenant(db, ctx.tenantId, async (tx) => {
    await tx.messageTemplate.upsert({
      where: { propertyId_key: { propertyId, key: d.key } },
      create: { tenantId: ctx.tenantId, propertyId, key: d.key, body: d.body, contentSid: d.contentSid || null, active: d.active },
      update: { body: d.body, contentSid: d.contentSid || null, active: d.active },
    });
    await audit(tx, ctx, { action: "messaging.template.save", entityType: "MessageTemplate", entityId: d.key, after: { active: d.active, hasContentSid: !!d.contentSid } });
  });
}

// ---------- sending ----------

export type QueueResult = { id: string; status: string; duplicate: boolean; error?: string | null };

/**
 * Sends one templated message about a reservation. Safe to call twice: the idempotency key (template + reservation
 * + an optional caller key) means a message that was sent, delivered or recorded in test mode is never sent again.
 * A previous FAILED attempt is not re-sent here; use retryMessage.
 */
export async function sendTemplate(
  db: PrismaClient,
  ctx: Ctx,
  input: unknown,
  driver: MessageDriver = getDriver(),
): Promise<QueueResult> {
  authorize(ctx, "guests.manage");
  const propertyId = requireProperty(ctx);
  const d = z.object({ reservationId: z.string().uuid(), templateKey: keySchema, nonce: z.string().max(40).optional() }).parse(input);
  const idempotencyKey = `${d.templateKey}:${d.reservationId}${d.nonce ? `:${d.nonce}` : ""}`;

  const prepared = await withTenant(db, ctx.tenantId, async (tx) => {
    const existing = await tx.messageLog.findUnique({ where: { propertyId_idempotencyKey: { propertyId, idempotencyKey } } });
    if (existing) return { kind: "dup", existing } as const;
    const res = await tx.reservation.findFirst({ where: { id: d.reservationId, propertyId }, include: { guest: true, property: true } });
    if (!res) throw new AppError("NOT_FOUND", "Reservation not found.");
    const consent = await tx.guestConsent.findUnique({ where: { guestId_channel: { guestId: res.guestId, channel: "WHATSAPP" } } });
    if (consent?.status !== "GRANTED") throw new AppError("FORBIDDEN", "This guest has not agreed to WhatsApp messages. Record consent first.");
    const to = toE164(res.guest.phone);
    if (!to) throw new AppError("VALIDATION", "The guest has no valid mobile number.");
    const tpl = await tx.messageTemplate.findUnique({ where: { propertyId_key: { propertyId, key: d.templateKey } } });
    if (tpl && !tpl.active) throw new AppError("VALIDATION", "This message template is switched off.");
    const folios = await tx.folio.findMany({ where: { reservationId: res.id }, select: { id: true } });
    let balance = 0;
    for (const f of folios) balance += await folioBalance(tx, f.id);
    const body = renderTemplate(tpl?.body ?? DEFAULT_BODIES[d.templateKey], {
      guest: res.guest.name.split(" ")[0], hotel: res.property.name, reference: res.reference,
      arrival: day(res.arrival), departure: day(res.departure), balance: formatInr(balance),
    });
    const log = await tx.messageLog.create({
      data: {
        tenantId: ctx.tenantId, propertyId, guestId: res.guestId, reservationId: res.id, templateKey: d.templateKey,
        toMasked: maskPhone(to), provider: driver.name, status: "PENDING", idempotencyKey, createdBy: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "message.queue", entityType: "MessageLog", entityId: log.id, after: { templateKey: d.templateKey } });
    return { kind: "new", log, to, body, contentSid: tpl?.contentSid ?? null } as const;
  });

  if (prepared.kind === "dup") {
    const e = prepared.existing;
    return { id: e.id, status: e.status, duplicate: true, error: e.error };
  }
  return deliver(db, ctx, prepared.log.id, { to: prepared.to, body: prepared.body, contentSid: prepared.contentSid }, driver);
}

async function deliver(
  db: PrismaClient,
  ctx: Ctx,
  logId: string,
  msg: { to: string; body: string; contentSid: string | null },
  driver: MessageDriver,
): Promise<QueueResult> {
  const base = process.env.AUTH_URL ?? "http://localhost:3000";
  const statusCallback = driver.name === "TWILIO" ? `${base}/api/webhooks/twilio?t=${ctx.tenantId}` : undefined;
  const r = await driver.send({ ...msg, statusCallback });
  // Only a real provider acceptance is SENT. Test mode is recorded as TEST so nothing is ever falsely reported as sent.
  const status = r.ok ? (driver.name === "TWILIO" ? "SENT" : "TEST") : "FAILED";
  await withTenant(db, ctx.tenantId, (tx) =>
    tx.messageLog.update({
      where: { id: logId },
      data: { status, attempts: { increment: 1 }, providerMessageId: r.ok ? r.providerMessageId : undefined, error: r.ok ? null : r.error },
    }),
  );
  return { id: logId, status, duplicate: false, error: r.ok ? null : r.error };
}

/** Re-sends a FAILED message. Anything else is refused, which is what stops duplicates. */
export async function retryMessage(db: PrismaClient, ctx: Ctx, logId: string, driver: MessageDriver = getDriver()): Promise<QueueResult> {
  authorize(ctx, "guests.manage");
  const propertyId = requireProperty(ctx);
  const claimed = await withTenant(db, ctx.tenantId, async (tx) => {
    // Atomic claim: only one concurrent retry can move FAILED to PENDING.
    const n = await tx.messageLog.updateMany({ where: { id: logId, propertyId, status: "FAILED" }, data: { status: "PENDING", error: null } });
    if (n.count === 0) throw new AppError("CONFLICT", "Only a failed message can be retried.");
    return tx.messageLog.findFirstOrThrow({ where: { id: logId } });
  });
  const prepared = await withTenant(db, ctx.tenantId, async (tx) => {
    const res = claimed.reservationId ? await tx.reservation.findFirst({ where: { id: claimed.reservationId }, include: { guest: true, property: true } }) : null;
    const consent = await tx.guestConsent.findUnique({ where: { guestId_channel: { guestId: claimed.guestId, channel: "WHATSAPP" } } });
    const to = toE164(res?.guest.phone);
    return { res, to, ok: consent?.status === "GRANTED" && !!res && !!to };
  });
  if (!prepared.ok || !prepared.res || !prepared.to) {
    await withTenant(db, ctx.tenantId, (tx) => tx.messageLog.update({ where: { id: logId }, data: { status: "FAILED", error: "Consent withdrawn or number missing." } }));
    throw new AppError("FORBIDDEN", "Consent was withdrawn or the guest's number is missing.");
  }
  const { res } = prepared;
  const tpl = await withTenant(db, ctx.tenantId, (tx) => tx.messageTemplate.findUnique({ where: { propertyId_key: { propertyId, key: claimed.templateKey } } }));
  const key = claimed.templateKey as TemplateKey;
  const body = renderTemplate(tpl?.body ?? DEFAULT_BODIES[key] ?? "", {
    guest: res.guest.name.split(" ")[0], hotel: res.property.name, reference: res.reference, arrival: day(res.arrival), departure: day(res.departure), balance: "",
  });
  return deliver(db, ctx, logId, { to: prepared.to, body, contentSid: tpl?.contentSid ?? null }, driver);
}

export async function listMessages(db: PrismaClient, ctx: Ctx, limit = 100) {
  authorize(ctx, "guests.view");
  const propertyId = requireProperty(ctx);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.messageLog.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" }, take: limit });
    const guests = await tx.guest.findMany({ where: { id: { in: rows.map((r) => r.guestId) } }, select: { id: true, name: true } });
    const res = await tx.reservation.findMany({ where: { id: { in: rows.map((r) => r.reservationId).filter((x): x is string => !!x) } }, select: { id: true, reference: true } });
    return rows.map((r) => ({
      ...r,
      guestName: guests.find((g) => g.id === r.guestId)?.name ?? "Guest",
      reference: res.find((x) => x.id === r.reservationId)?.reference ?? null,
    }));
  });
}

/** Applies a verified provider callback. The tenant comes from the signed callback URL. */
export async function applyDeliveryStatus(db: PrismaClient, tenantId: string, providerMessageId: string, providerStatus: string, errorCode?: string) {
  const mapped = mapTwilioStatus(providerStatus);
  if (!mapped) return false;
  return withTenant(db, tenantId, async (tx) => {
    const log = await tx.messageLog.findFirst({ where: { providerMessageId } });
    if (!log) return false;
    // Never move backwards from DELIVERED to SENT (callbacks can arrive out of order).
    if (log.status === "DELIVERED" && mapped !== "FAILED") return true;
    await tx.messageLog.update({
      where: { id: log.id },
      data: { status: mapped, error: mapped === "FAILED" ? `Delivery failed${errorCode ? ` (code ${errorCode})` : ""}.` : null },
    });
    return true;
  });
}
