import { describe, expect, it } from "vitest";
import { maskPhone, toE164 } from "./phone";
import { mapTwilioStatus, TestDriver, TwilioDriver, twilioConfig, twilioSignature, verifyTwilioSignature } from "./provider";
import { DEFAULT_BODIES, renderTemplate, TEMPLATE_KEYS } from "./templates";

const cfg = { accountSid: "AC1", authToken: "t", from: "+14155550100" };

describe("phone", () => {
  it("normalises and masks", () => {
    expect(toE164("98765 43210")).toBe("+919876543210");
    expect(toE164("09876543210")).toBe("+919876543210");
    expect(toE164("+44 7700 900123")).toBe("+447700900123");
    expect(toE164("12345")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(maskPhone("+919876543210")).toBe("+91******3210");
  });
});

describe("templates", () => {
  it("renders known variables and leaves unknown ones visible", () => {
    expect(renderTemplate("Hi {{guest}} {{ hotel }} {{oops}}", { guest: "Asha", hotel: "MK" })).toBe("Hi Asha MK {{oops}}");
    for (const k of TEMPLATE_KEYS) expect(DEFAULT_BODIES[k].length).toBeGreaterThan(10);
  });
});

describe("provider", () => {
  it("is unconfigured without all three env vars", () => {
    expect(twilioConfig({ TWILIO_ACCOUNT_SID: "AC1" })).toBeNull();
    expect(twilioConfig({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_WHATSAPP_FROM: "+1415" })).not.toBeNull();
  });
  it("verifies signatures and rejects tampering", () => {
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const sig = twilioSignature("secret", "https://x.test/hook?t=1", params);
    expect(verifyTwilioSignature("secret", "https://x.test/hook?t=1", params, sig)).toBe(true);
    expect(verifyTwilioSignature("secret", "https://x.test/hook?t=1", { ...params, MessageStatus: "failed" }, sig)).toBe(false);
    expect(verifyTwilioSignature("secret", "https://x.test/hook?t=2", params, sig)).toBe(false);
    expect(verifyTwilioSignature("secret", "https://x.test/hook?t=1", params, null)).toBe(false);
  });
  it("maps statuses", () => {
    expect([mapTwilioStatus("delivered"), mapTwilioStatus("undelivered"), mapTwilioStatus("queued"), mapTwilioStatus("weird")]).toEqual(["DELIVERED", "FAILED", "SENT", null]);
  });
  it("TwilioDriver reports provider errors without leaking details and never throws", async () => {
    const bad = new TwilioDriver(cfg, (async () => new Response(JSON.stringify({ code: 63016, message: "secret detail" }), { status: 400 })) as typeof fetch);
    expect(await bad.send({ to: "+919876543210", body: "x" })).toEqual({ ok: false, error: "Provider rejected the message (code 63016)." });
    const down = new TwilioDriver(cfg, (async () => { throw new Error("net"); }) as typeof fetch);
    expect((await down.send({ to: "+919876543210", body: "x" })).ok).toBe(false);
    const ok = new TwilioDriver(cfg, (async () => new Response(JSON.stringify({ sid: "SM9" }), { status: 201 })) as typeof fetch);
    expect(await ok.send({ to: "+919876543210", body: "x" })).toEqual({ ok: true, providerMessageId: "SM9" });
  });
  it("TestDriver issues test ids", async () => {
    const r = await new TestDriver().send();
    expect(r.ok && r.providerMessageId.startsWith("TEST-")).toBe(true);
  });
});
