import { createHmac, timingSafeEqual } from "node:crypto";

export type SendInput = { to: string; body: string; contentSid?: string | null; statusCallback?: string };
export type SendResult = { ok: true; providerMessageId: string } | { ok: false; error: string };

export interface MessageDriver {
  readonly name: "TWILIO" | "TEST";
  send(input: SendInput): Promise<SendResult>;
}

export type TwilioConfig = { accountSid: string; authToken: string; from: string };

export function twilioConfig(env: Record<string, string | undefined> = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_WHATSAPP_FROM;
  return accountSid && authToken && from ? { accountSid, authToken, from } : null;
}

export class TwilioDriver implements MessageDriver {
  readonly name = "TWILIO" as const;
  constructor(private readonly cfg: TwilioConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(input: SendInput): Promise<SendResult> {
    const form = new URLSearchParams({
      To: `whatsapp:${input.to}`,
      From: this.cfg.from.startsWith("whatsapp:") ? this.cfg.from : `whatsapp:${this.cfg.from}`,
    });
    if (input.contentSid) form.set("ContentSid", input.contentSid);
    else form.set("Body", input.body);
    if (input.statusCallback) form.set("StatusCallback", input.statusCallback);
    try {
      const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; code?: number };
      if (res.ok && json.sid) return { ok: true, providerMessageId: json.sid };
      return { ok: false, error: `Provider rejected the message${json.code ? ` (code ${json.code})` : ""}.` };
    } catch {
      return { ok: false, error: "Could not reach the messaging provider." };
    }
  }
}

/** Used when credentials are missing. It never contacts anyone, and its results are recorded as TEST, not SENT. */
export class TestDriver implements MessageDriver {
  readonly name = "TEST" as const;
  async send(): Promise<SendResult> {
    return { ok: true, providerMessageId: `TEST-${Date.now().toString(36)}` };
  }
}

export function getDriver(env: Record<string, string | undefined> = process.env): MessageDriver {
  const cfg = twilioConfig(env);
  return cfg ? new TwilioDriver(cfg) : new TestDriver();
}

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null): boolean {
  if (!header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Maps Twilio message statuses to ours. */
export function mapTwilioStatus(s: string): "SENT" | "DELIVERED" | "FAILED" | null {
  if (s === "delivered" || s === "read") return "DELIVERED";
  if (s === "failed" || s === "undelivered") return "FAILED";
  if (s === "sent" || s === "queued" || s === "sending" || s === "accepted") return "SENT";
  return null;
}
