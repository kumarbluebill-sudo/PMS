import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { twilioConfig, verifyTwilioSignature } from "@/server/messaging/provider";
import { rateLimit } from "@/server/rateLimit";
import { applyDeliveryStatus } from "@/server/services/messaging";

const UUID = /^[0-9a-f-]{36}$/i;

/** Twilio delivery-status callback. Authenticated by Twilio's request signature, not by a session. */
export async function POST(req: NextRequest) {
  const cfg = twilioConfig();
  if (!cfg) return new NextResponse("Not configured", { status: 404 });
  if (!rateLimit("twilio-webhook", 600, 60_000)) return new NextResponse("Too many requests", { status: 429 });
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
  const base = process.env.AUTH_URL ?? req.nextUrl.origin;
  const url = `${base}${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (!verifyTwilioSignature(cfg.authToken, url, params, req.headers.get("x-twilio-signature"))) {
    return new NextResponse("Invalid signature", { status: 403 });
  }
  const tenantId = req.nextUrl.searchParams.get("t") ?? "";
  if (!UUID.test(tenantId) || !params.MessageSid) return new NextResponse("Bad request", { status: 400 });
  await applyDeliveryStatus(getDb(), tenantId, params.MessageSid, params.MessageStatus ?? "", params.ErrorCode);
  return new NextResponse(null, { status: 204 });
}
