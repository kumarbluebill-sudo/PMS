"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/server/db/client";
import { AppError, toSafeError } from "@/server/errors";
import { getCtx } from "@/server/session";
import { retryMessage, saveTemplate, sendTemplate, setConsent } from "@/server/services/messaging";
import { sendConfirmationEmail } from "@/server/services/emailOutbox";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Same-site relative paths only, so a forged form cannot redirect elsewhere. */
const safeBack = (v: string, fallback: string) => (/^\/app\/[\w\-/]*$/.test(v) ? v : fallback);

async function go(back: string, fn: () => Promise<string | void>) {
  let msg = "";
  let isErr = false;
  try {
    msg = (await fn()) ?? "";
  } catch (e) {
    msg = toSafeError(e).message;
    isErr = true;
  }
  revalidatePath("/app", "layout");
  redirect(`${back}?${isErr ? "error" : "ok"}=${encodeURIComponent(msg || "Done.")}`);
}

export async function consentAction(fd: FormData) {
  const ctx = await getCtx();
  const back = safeBack(str(fd.get("back")), "/app/messages");
  await go(back, async () => {
    await setConsent(getDb(), ctx, { guestId: str(fd.get("guestId")), status: str(fd.get("status")), source: str(fd.get("source")), channel: str(fd.get("channel")) || "WHATSAPP" });
    return "Consent recorded.";
  });
}

export async function sendMessageAction(fd: FormData) {
  const ctx = await getCtx();
  const back = safeBack(str(fd.get("back")), "/app/messages");
  await go(back, async () => {
    const r = await sendTemplate(getDb(), ctx, { reservationId: str(fd.get("reservationId")), templateKey: str(fd.get("templateKey")), nonce: ["payment_reminder", "checkout_reminder"].includes(str(fd.get("templateKey"))) ? new Date().toISOString().slice(0, 10) : undefined });
    if (r.duplicate) return `Already ${r.status.toLowerCase()}. Nothing was sent again.`;
    if (r.status === "FAILED") throw new AppError("VALIDATION", r.error ?? "The message could not be sent.");
    return r.status === "TEST" ? "Recorded in test mode. Nothing was delivered because WhatsApp is not connected." : "Message handed to WhatsApp. Delivery status will update.";
  });
}

export async function sendConfirmationEmailAction(fd: FormData) {
  const ctx = await getCtx();
  const back = safeBack(str(fd.get("back")), "/app/messages");
  await go(back, async () => {
    const r = await sendConfirmationEmail(getDb(), ctx, { reservationId: str(fd.get("reservationId")), nonce: str(fd.get("nonce")) || undefined });
    if (r.duplicate) return `This confirmation was already emailed (${r.row.status.toLowerCase()}). Nothing was sent again.`;
    if (r.row.status === "FAILED") throw new AppError("VALIDATION", r.row.error ?? "The email could not be sent.");
    return r.row.status === "TEST" ? "Recorded in test mode. Nothing was emailed because no email provider is connected." : "Email accepted by the provider. Delivery is confirmed separately when the provider reports it.";
  });
}

export async function retryMessageAction(fd: FormData) {
  const ctx = await getCtx();
  await go("/app/messages", async () => {
    const r = await retryMessage(getDb(), ctx, str(fd.get("id")));
    if (r.status === "FAILED") throw new AppError("VALIDATION", r.error ?? "The message failed again.");
    return r.status === "TEST" ? "Recorded in test mode." : "Message handed to WhatsApp.";
  });
}

export async function saveTemplateAction(fd: FormData) {
  const ctx = await getCtx();
  await go("/app/messages", async () => {
    await saveTemplate(getDb(), ctx, { key: str(fd.get("key")), body: str(fd.get("body")), contentSid: str(fd.get("contentSid")), active: str(fd.get("active")) === "on" });
    return "Template saved.";
  });
}
