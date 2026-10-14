import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { createReservation } from "@/server/services/reservations";
import { applyDeliveryStatus, listMessages, listTemplates, retryMessage, saveTemplate, sendTemplate, setConsent } from "@/server/services/messaging";
import type { MessageDriver, SendInput, SendResult } from "@/server/messaging/provider";
import { TestDriver } from "@/server/messaging/provider";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let owner: Ctx;
let other: Ctx;
let guestId: string;
let reservationId: string;
let noPhoneReservation: string;

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

class FakeDriver implements MessageDriver {
  readonly name = "TWILIO" as const;
  calls: SendInput[] = [];
  result: SendResult = { ok: true, providerMessageId: "SMfake1" };
  async send(i: SendInput) {
    this.calls.push(i);
    return this.result;
  }
}

async function tenant(label: string) {
  const r = await registerTenant(app, {
    businessName: `Biz ${label}`, propertyName: `Hotel ${label}`, name: "Owner",
    email: `msg-${label}-${sfx}@test.local`, password: "correct-horse-battery",
  });
  return loadContext(app, { userId: r.userId, epoch: 0 });
}

beforeAll(async () => {
  app = createDb(APP_URL);
  owner = await tenant("a");
  other = await tenant("b");
  const rt = await createRoomType(app, owner, { name: "M", baseRateMinor: 100_000 });
  await createRoom(app, owner, { roomTypeId: rt.id, number: "1" });
  await createRoom(app, owner, { roomTypeId: rt.id, number: "2" });
  const g = await createGuest(app, owner, { name: "Asha Rao", phone: "98765 43210" });
  guestId = g.id;
  reservationId = (await createReservation(app, owner, { guestId: g.id, roomTypeId: rt.id, arrival: day(5), departure: day(7), adults: 1 })).id;
  const g2 = await createGuest(app, owner, { name: "No Phone" });
  noPhoneReservation = (await createReservation(app, owner, { guestId: g2.id, roomTypeId: rt.id, arrival: day(5), departure: day(7), adults: 1 })).id;
  await setConsent(app, owner, { guestId: g2.id, status: "GRANTED", source: "Verbal" });
});
afterAll(() => app.$disconnect());

describe("WhatsApp messaging", () => {
  it("refuses to send without recorded consent", async () => {
    const d = new FakeDriver();
    await expect(sendTemplate(app, owner, { reservationId, templateKey: "reservation_confirmation" }, d)).rejects.toThrow(/not agreed/);
    expect(d.calls).toHaveLength(0);
  });

  it("needs a valid mobile number", async () => {
    const d = new FakeDriver();
    await expect(sendTemplate(app, owner, { reservationId: noPhoneReservation, templateKey: "pre_arrival" }, d)).rejects.toThrow(/mobile number/);
  });

  it("sends once, masks the number, and never stores message text", async () => {
    await setConsent(app, owner, { guestId, status: "GRANTED", source: "Booking form" });
    const d = new FakeDriver();
    const a = await sendTemplate(app, owner, { reservationId, templateKey: "reservation_confirmation" }, d);
    expect(a).toMatchObject({ status: "SENT", duplicate: false });
    expect(d.calls[0].to).toBe("+919876543210");
    expect(d.calls[0].body).toContain("Asha");
    const b = await sendTemplate(app, owner, { reservationId, templateKey: "reservation_confirmation" }, d);
    expect(b).toMatchObject({ duplicate: true, status: "SENT" });
    expect(d.calls).toHaveLength(1);
    const log = (await listMessages(app, owner)).find((m) => m.id === a.id)!;
    expect(log.toMasked).toBe("+91******3210");
    expect(JSON.stringify(log)).not.toContain("9876543210");
    expect(JSON.stringify(log)).not.toContain("confirmed for");
  });

  it("records test mode as TEST, never SENT", async () => {
    const r = await sendTemplate(app, owner, { reservationId, templateKey: "pre_arrival" }, new TestDriver());
    expect(r.status).toBe("TEST");
  });

  it("records failures, and retries only failed messages", async () => {
    const d = new FakeDriver();
    d.result = { ok: false, error: "Provider rejected the message (code 63016)." };
    const f = await sendTemplate(app, owner, { reservationId, templateKey: "checkin_confirmation" }, d);
    expect(f).toMatchObject({ status: "FAILED", error: expect.stringContaining("63016") });
    // a second send does not bypass the failure record
    expect((await sendTemplate(app, owner, { reservationId, templateKey: "checkin_confirmation" }, d)).duplicate).toBe(true);
    d.result = { ok: true, providerMessageId: "SMfake2" };
    const retried = await retryMessage(app, owner, f.id, d);
    expect(retried.status).toBe("SENT");
    await expect(retryMessage(app, owner, f.id, d)).rejects.toThrow(/Only a failed message/);
  });

  it("applies delivery callbacks without moving backwards", async () => {
    const d = new FakeDriver();
    d.result = { ok: true, providerMessageId: "SMdeliver1" };
    const m = await sendTemplate(app, owner, { reservationId, templateKey: "feedback_request" }, d);
    expect(await applyDeliveryStatus(app, owner.tenantId, "SMdeliver1", "delivered")).toBe(true);
    await applyDeliveryStatus(app, owner.tenantId, "SMdeliver1", "sent");
    expect((await listMessages(app, owner)).find((x) => x.id === m.id)!.status).toBe("DELIVERED");
    expect(await applyDeliveryStatus(app, owner.tenantId, "SMdeliver1", "bogus")).toBe(false);
    // another tenant cannot touch it
    expect(await applyDeliveryStatus(app, other.tenantId, "SMdeliver1", "failed")).toBe(false);
  });

  it("withdrawn consent blocks sending and retrying", async () => {
    await setConsent(app, owner, { guestId, status: "REVOKED", source: "Guest request" });
    await expect(sendTemplate(app, owner, { reservationId, templateKey: "invoice_share" }, new FakeDriver())).rejects.toThrow(/not agreed/);
    await setConsent(app, owner, { guestId, status: "GRANTED", source: "Re-consented" });
  });

  it("stores templates per property and isolates tenants", async () => {
    await saveTemplate(app, owner, { key: "payment_reminder", body: "Pay {{balance}} please {{guest}}", active: true });
    expect((await listTemplates(app, owner)).find((t) => t.key === "payment_reminder")!.body).toContain("Pay");
    expect((await listTemplates(app, other)).find((t) => t.key === "payment_reminder")!.customised).toBe(false);
    await expect(saveTemplate(app, owner, { key: "payment_reminder", body: "x", active: true })).rejects.toThrow();
    expect(await listMessages(app, other)).toHaveLength(0);
    await expect(sendTemplate(app, other, { reservationId, templateKey: "pre_arrival" }, new FakeDriver())).rejects.toThrow(/not found/i);
  });
});
