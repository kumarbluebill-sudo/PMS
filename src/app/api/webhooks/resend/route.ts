import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { emailConfig, verifyWebhookSignature } from "@/server/messaging/email";
import { rateLimit } from "@/server/rateLimit";
import { applyEmailEvent } from "@/server/services/emailOutbox";

/** Resend delivery events (delivered, bounced, complained). Authenticated by the Svix signature, not by a session. */
export async function POST(req: NextRequest) {
  const cfg = emailConfig();
  if (!cfg?.webhookSecret) return new NextResponse("Not configured", { status: 404 });
  if (!rateLimit("resend-webhook", 600, 60_000)) return new NextResponse("Too many requests", { status: 429 });
  const body = await req.text();
  const ok = verifyWebhookSignature({
    secret: cfg.webhookSecret, id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature"), body,
  });
  if (!ok) return new NextResponse("Invalid signature", { status: 403 });
  let event: { type?: string; data?: { email_id?: string } };
  try { event = JSON.parse(body); } catch { return new NextResponse("Bad request", { status: 400 }); }
  if (event.type && event.data?.email_id) await applyEmailEvent(getDb(), event.data.email_id, event.type);
  return new NextResponse(null, { status: 204 });
}
