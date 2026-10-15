import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Email through Resend. Without RESEND_API_KEY and EMAIL_FROM nothing is sent and the message is recorded as TEST.
 * A successful API call means the provider ACCEPTED the message; it is never described as delivered. DELIVERED and
 * BOUNCED arrive only from the provider's signed webhook.
 */
export type EmailConfig = { apiKey: string; from: string; webhookSecret: string | null };

export const emailConfig = (env: Record<string, string | undefined> = process.env): EmailConfig | null => {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  return apiKey && from ? { apiKey, from, webhookSecret: env.RESEND_WEBHOOK_SECRET?.trim() || null } : null;
};

export type EmailAttachment = { filename: string; content: Uint8Array };
export type EmailMessage = { to: string; subject: string; text: string; html?: string; attachments?: EmailAttachment[]; idempotencyKey: string };
export type EmailResult = { ok: true; id: string } | { ok: false; error: string };

export const isEmail = (s: string | null | undefined): s is string => !!s && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** One attempt, with a timeout, and an idempotency key so a retry by the provider or by us cannot send twice. */
export async function sendViaResend(cfg: EmailConfig, m: EmailMessage, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<EmailResult> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", "idempotency-key": m.idempotencyKey.slice(0, 256) },
      body: JSON.stringify({
        from: cfg.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html && { html: m.html }),
        ...(m.attachments?.length && { attachments: m.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") })) }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let msg = "";
      try { msg = (JSON.parse(body) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
      return { ok: false, error: `Email provider refused the message (${res.status})${msg ? `: ${msg.slice(0, 200)}` : ""}.` };
    }
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    return j.id ? { ok: true, id: j.id } : { ok: false, error: "Email provider did not return a message id." };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "Email provider did not answer in time." : "Email provider could not be reached." };
  }
}

/**
 * Verifies a Svix-style webhook signature (the scheme Resend uses): HMAC-SHA256 of `${id}.${timestamp}.${body}` with the
 * base64 key after `whsec_`, compared in constant time against every `v1,<signature>` in the header. Old timestamps are
 * refused so a captured request cannot be replayed later.
 */
export function verifyWebhookSignature(o: { secret: string; id: string | null; timestamp: string | null; signature: string | null; body: string; nowMs?: number; toleranceSec?: number }): boolean {
  if (!o.id || !o.timestamp || !o.signature) return false;
  const ts = Number(o.timestamp);
  if (!Number.isFinite(ts) || Math.abs((o.nowMs ?? Date.now()) / 1000 - ts) > (o.toleranceSec ?? 300)) return false;
  const key = Buffer.from(o.secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${o.id}.${o.timestamp}.${o.body}`).digest();
  return o.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export type EmailStatus = "QUEUED" | "ACCEPTED" | "DELIVERED" | "BOUNCED" | "FAILED" | "TEST" | "SENT";

/** Map a provider event to a status. Unknown events change nothing. */
export function statusFromEvent(type: string): EmailStatus | null {
  switch (type) {
    case "email.delivered": return "DELIVERED";
    case "email.bounced":
    case "email.complained": return "BOUNCED";
    case "email.failed": return "FAILED";
    case "email.sent": return "ACCEPTED";
    default: return null;
  }
}

const RANK: Record<EmailStatus, number> = { QUEUED: 0, TEST: 0, SENT: 1, ACCEPTED: 1, FAILED: 2, DELIVERED: 3, BOUNCED: 3 };
/** Status only moves forward: a late "accepted" never undoes "delivered", and a final state is not overwritten. */
export const advanceStatus = (current: EmailStatus, incoming: EmailStatus): EmailStatus =>
  (current === "DELIVERED" || current === "BOUNCED") || RANK[incoming] <= RANK[current] ? current : incoming;
