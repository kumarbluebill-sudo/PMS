import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { advanceStatus, emailConfig, isEmail, sendViaResend, statusFromEvent, verifyWebhookSignature } from "./email";

const secretBytes = Buffer.from("super-secret-key-bytes-1234567890");
const secret = `whsec_${secretBytes.toString("base64")}`;
const sign = (id: string, ts: string, body: string) => `v1,${createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64")}`;

describe("emailConfig", () => {
  it("is off unless both the key and the sender are set", () => {
    expect(emailConfig({})).toBeNull();
    expect(emailConfig({ RESEND_API_KEY: "k" })).toBeNull();
    expect(emailConfig({ EMAIL_FROM: "a@b.test" })).toBeNull();
    expect(emailConfig({ RESEND_API_KEY: " k ", EMAIL_FROM: "Hotel <a@b.test>", RESEND_WEBHOOK_SECRET: "whsec_x" })).toEqual({ apiKey: "k", from: "Hotel <a@b.test>", webhookSecret: "whsec_x" });
  });
  it("checks email addresses", () => {
    expect(isEmail("asha@example.com")).toBe(true);
    for (const bad of ["", null, "asha", "a@b", "a b@c.com", "x@y.z"]) expect(isEmail(bad as string)).toBe(false);
  });
});

describe("webhook signature", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
  const ok = { secret, id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body), body, nowMs: now };
  it("accepts a correct signature, including one of several in the header", () => {
    expect(verifyWebhookSignature(ok)).toBe(true);
    expect(verifyWebhookSignature({ ...ok, signature: `v1,AAAA ${ok.signature}` })).toBe(true);
  });
  it("refuses a wrong secret, a changed body, missing headers and an old timestamp", () => {
    expect(verifyWebhookSignature({ ...ok, secret: `whsec_${Buffer.from("other").toString("base64")}` })).toBe(false);
    expect(verifyWebhookSignature({ ...ok, body: body + " " })).toBe(false);
    expect(verifyWebhookSignature({ ...ok, id: null })).toBe(false);
    expect(verifyWebhookSignature({ ...ok, signature: null })).toBe(false);
    expect(verifyWebhookSignature({ ...ok, nowMs: now + 10 * 60_000 })).toBe(false);
    expect(verifyWebhookSignature({ ...ok, signature: "v2," + ok.signature.slice(3) })).toBe(false);
  });
});

describe("status", () => {
  it("maps provider events and ignores unknown ones", () => {
    expect(statusFromEvent("email.delivered")).toBe("DELIVERED");
    expect(statusFromEvent("email.bounced")).toBe("BOUNCED");
    expect(statusFromEvent("email.complained")).toBe("BOUNCED");
    expect(statusFromEvent("email.opened")).toBeNull();
  });
  it("only moves forward and never leaves a final state", () => {
    expect(advanceStatus("QUEUED", "ACCEPTED")).toBe("ACCEPTED");
    expect(advanceStatus("ACCEPTED", "DELIVERED")).toBe("DELIVERED");
    expect(advanceStatus("DELIVERED", "ACCEPTED")).toBe("DELIVERED");
    expect(advanceStatus("DELIVERED", "BOUNCED")).toBe("DELIVERED");
    expect(advanceStatus("ACCEPTED", "QUEUED")).toBe("ACCEPTED");
    expect(advanceStatus("TEST", "DELIVERED")).toBe("DELIVERED");
  });
});

describe("sendViaResend", () => {
  const cfg = { apiKey: "k", from: "a@b.test", webhookSecret: null };
  const msg = { to: "g@x.test", subject: "Hi", text: "Hello", idempotencyKey: "key-1", attachments: [{ filename: "a.pdf", content: new Uint8Array([1, 2, 3]) }] };
  it("returns the provider id as ACCEPTED data, sending the key, attachment and idempotency header", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const r = await sendViaResend(cfg, msg, async (_u, init) => { seen = init; return { ok: true, status: 200, json: async () => ({ id: "re_123" }), text: async () => "" }; });
    expect(r).toEqual({ ok: true, id: "re_123" });
    expect(seen!.headers.authorization).toBe("Bearer k");
    expect(seen!.headers["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(seen!.body).attachments[0]).toEqual({ filename: "a.pdf", content: "AQID" });
  });
  it("reports a refusal, a missing id and a network failure without throwing", async () => {
    const refuse = await sendViaResend(cfg, msg, async () => ({ ok: false, status: 422, json: async () => ({}), text: async () => JSON.stringify({ message: "domain not verified" }) }));
    expect(refuse).toMatchObject({ ok: false, error: expect.stringContaining("domain not verified") });
    expect(await sendViaResend(cfg, msg, async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }))).toMatchObject({ ok: false });
    expect(await sendViaResend(cfg, msg, async () => { throw new Error("down"); })).toMatchObject({ ok: false, error: expect.stringContaining("could not be reached") });
  });
});
