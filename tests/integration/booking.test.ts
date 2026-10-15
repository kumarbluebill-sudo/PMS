import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createDb } from "@/server/db/client";
import { loadContext, type Ctx } from "@/server/auth/context";
import { gstinCheckChar } from "@/server/domain/gst";
import { registerTenant } from "@/server/services/tenant";
import { createRoom, createRoomType } from "@/server/services/rooms";
import { createGuest } from "@/server/services/guests";
import { availabilityByType, bookingConfirmation, createBooking, quoteStay } from "@/server/services/booking";
import { cancelReservation, confirmReservation } from "@/server/services/reservations";
import { postRoomNights } from "@/server/services/billing";
import { approveRule, createRule, updateGstSettings } from "@/server/services/tax";
import { roomBoard } from "@/server/services/dashboard";
import { ADMIN_URL } from "./global-setup";

const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//pms_app:pms_app_pw@");
const sfx = Date.now().toString(36);
let app: PrismaClient;
let admin: PrismaClient;
let owner: Ctx;
let other: Ctx;
let today: string;
let deluxe: string;
let suite: string;
const roomIds: Record<string, string> = {};

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asRole = (c: Ctx, role: Ctx["role"]): Ctx => ({ ...c, role, extra: [], userId: randomUUID() });
let n = 0;
const guest = (extra: object = {}) => ({ name: `Guest ${++n}`, mobile: `98765${String(10000 + n)}`, ...extra });
// Each test books its own window so tests never compete for the same nights.
let window = 100;
const dates = (nights = 2) => {
  const from = addDays(today, (window += 10));
  return { arrival: from, departure: addDays(from, nights) };
};

beforeAll(async () => {
  app = createDb(APP_URL);
  admin = createDb(ADMIN_URL);
  const mk = async (label: string) =>
    loadContext(app, {
      userId: (await registerTenant(app, { businessName: `B ${label}`, propertyName: `H ${label}`, name: "Owner", email: `bk-${label}-${sfx}@test.local`, password: "correct-horse-battery" })).userId,
      epoch: 0,
    });
  owner = await mk("a");
  other = await mk("b");
  today = (await roomBoard(app, owner)).today;
  const d = await createRoomType(app, owner, { name: "Deluxe", maxAdults: 2, maxChildren: 1, baseRateMinor: 450_000 });
  const s = await createRoomType(app, owner, { name: "Suite", maxAdults: 3, maxChildren: 2, baseRateMinor: 900_000 });
  deluxe = d.id;
  suite = s.id;
  for (const num of ["301", "302", "303"]) roomIds[num] = (await createRoom(app, owner, { roomTypeId: deluxe, number: num })).id;
  roomIds["401"] = (await createRoom(app, owner, { roomTypeId: suite, number: "401" })).id;
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("quote (server-side price and availability)", () => {
  it("counts free rooms, nights and totals from stored rates", async () => {
    const w = dates();
    const q = await quoteStay(app, owner, { roomTypeId: deluxe, ...w, rooms: 1 });
    expect(q).toMatchObject({ available: 3, nights: 2, baseRateMinor: 450_000, rateMinor: 450_000, subtotalMinor: 900_000, taxMinor: 0, totalMinor: 900_000, taxStatus: "NOT_REGISTERED" });
    const two = await quoteStay(app, owner, { roomTypeId: deluxe, ...w, rooms: 2 });
    expect(two).toMatchObject({ subtotalMinor: 1_800_000, totalMinor: 1_800_000 });
    expect(two.nightly).toHaveLength(2);
  });

  it("applies percentage and fixed discounts per night", async () => {
    const w = dates();
    expect((await quoteStay(app, owner, { roomTypeId: deluxe, ...w, discountPercentBp: 1000 })).totalMinor).toBe(810_000);
    expect((await quoteStay(app, owner, { roomTypeId: deluxe, ...w, discountAmountMinor: 50_000 })).totalMinor).toBe(800_000);
    await expect(quoteStay(app, owner, { roomTypeId: deluxe, ...w, discountPercentBp: 500, discountAmountMinor: 100 })).rejects.toThrow(/either a percentage or an amount/);
  });

  it("rejects invalid date ranges and unknown room types", async () => {
    const day = addDays(today, 300);
    await expect(quoteStay(app, owner, { roomTypeId: deluxe, arrival: day, departure: day })).rejects.toThrow(/after check-in/);
    await expect(quoteStay(app, owner, { roomTypeId: deluxe, arrival: day, departure: addDays(day, -1) })).rejects.toThrow(/after check-in/);
    await expect(quoteStay(app, owner, { roomTypeId: deluxe, arrival: "2026-13-45", departure: "2026-13-46" })).rejects.toThrow();
    await expect(quoteStay(app, owner, { roomTypeId: deluxe, arrival: day, departure: addDays(day, 400) })).rejects.toThrow(/365/);
    await expect(quoteStay(app, other, { roomTypeId: deluxe, arrival: day, departure: addDays(day, 1) })).rejects.toThrow(/not found/i);
  });

  it("availability by type lists every type with real counts", async () => {
    const w = dates();
    await createBooking(app, owner, { newGuest: guest(), roomTypeId: suite, ...w, adults: 2 });
    const a = await availabilityByType(app, owner, w.arrival, w.departure);
    expect(a.find((t) => t.name === "Suite")).toMatchObject({ available: 0, totalRooms: 1 });
    expect(a.find((t) => t.name === "Deluxe")).toMatchObject({ available: 3, totalRooms: 3, baseRateMinor: 450_000 });
  });
});

describe("booking", () => {
  it("creates a booking with a new guest, normalising the mobile and generating a unique reference", async () => {
    const w = dates();
    const r = await createBooking(app, owner, { newGuest: guest({ mobile: "+91 98765-43210", email: "a@b.in", address: "1 Road", idType: "AADHAAR", idNumber: "123412341234" }), roomTypeId: deluxe, ...w, adults: 2, source: "PHONE", notes: "Late arrival" });
    const [res] = r.reservations;
    expect(res.reference).toMatch(/^MK-[0-9A-F]{8}$/);
    expect(res).toMatchObject({ status: "CONFIRMED", source: "PHONE", notes: "Late arrival", quotedTotalMinor: 900_000, groupRef: null });
    const g = await admin.guest.findUniqueOrThrow({ where: { id: res.guestId } });
    expect(g).toMatchObject({ phone: "+919876543210", address: "1 Road", idType: "AADHAAR" });
    expect(g.idNumberEnc).toBeTruthy();
    expect(g.idNumberEnc).not.toContain("1234"); // stored encrypted
    const refs = new Set<string>();
    for (let i = 0; i < 5; i++) refs.add((await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...dates(1), adults: 1 })).reservations[0].reference);
    expect(refs.size).toBe(5);
  });

  it("requires a valid mobile number and a guest name", async () => {
    const w = dates();
    await expect(createBooking(app, owner, { newGuest: guest({ mobile: "12" }), roomTypeId: deluxe, ...w })).rejects.toThrow(/valid mobile/);
    await expect(createBooking(app, owner, { newGuest: guest({ mobile: "" }), roomTypeId: deluxe, ...w })).rejects.toThrow(/mobile/i);
    await expect(createBooking(app, owner, { newGuest: guest({ name: "" }), roomTypeId: deluxe, ...w })).rejects.toThrow(/name/i);
    await expect(createBooking(app, owner, { roomTypeId: deluxe, ...w })).rejects.toThrow(/existing guest or enter a new one/);
    const bare = await createGuest(app, owner, { name: "No Phone" });
    await expect(createBooking(app, owner, { guestId: bare.id, roomTypeId: deluxe, ...w })).rejects.toThrow(/no mobile number/);
    const ok = await createBooking(app, owner, { guestId: bare.id, mobile: "9000000001", roomTypeId: deluxe, ...w });
    expect((await admin.guest.findUniqueOrThrow({ where: { id: bare.id } })).phone).toBe("9000000001");
    expect(ok.reservations).toHaveLength(1);
  });

  it("rejects past check-in and invalid ranges when saving", async () => {
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, arrival: addDays(today, -1), departure: today })).rejects.toThrow(/in the past/);
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, arrival: today, departure: today })).rejects.toThrow(/after check-in/);
  });

  it("books several rooms at once in a group with distinct rooms and unique references", async () => {
    const w = dates();
    const r = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, rooms: 2, adults: 3, children: 1 });
    expect(r.reservations).toHaveLength(2);
    expect(new Set(r.reservations.map((x) => x.roomId)).size).toBe(2);
    expect(new Set(r.reservations.map((x) => x.reference)).size).toBe(2);
    expect(r.groupRef).toMatch(/^MK-G[0-9A-F]{6}$/);
    expect(r.reservations.every((x) => x.groupRef === r.groupRef && x.quotedTotalMinor === 900_000)).toBe(true);
    expect(r.reservations.reduce((t, x) => t + x.adults, 0)).toBe(3);
    expect(r.reservations.reduce((t, x) => t + x.children, 0)).toBe(1);
    expect(r.quote.totalMinor).toBe(1_800_000);
    // Only one Deluxe is left in that window.
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, rooms: 2 })).rejects.toThrow(/Only 1 room/);
    await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w });
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w })).rejects.toThrow(/No room of this type is available/);
  });

  it("checks occupancy against the room type", async () => {
    const w = dates();
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, adults: 3 })).rejects.toThrow(/occupancy/);
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, adults: 2, children: 2 })).rejects.toThrow(/occupancy/);
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, rooms: 2, adults: 4, children: 2 })).resolves.toBeTruthy();
  });

  it("prevents double booking under concurrency: 6 requests for 1 suite, 5 for 3 deluxe rooms", async () => {
    const w = dates();
    const suiteRes = await Promise.allSettled(Array.from({ length: 6 }, () => createBooking(app, owner, { newGuest: guest(), roomTypeId: suite, ...w })));
    expect(suiteRes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const w2 = dates();
    const dlx = await Promise.allSettled(Array.from({ length: 5 }, () => createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w2 })));
    const ok = dlx.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof createBooking>>>[];
    expect(ok).toHaveLength(3);
    expect(new Set(ok.map((r) => r.value.reservations[0].roomId)).size).toBe(3);
    const rejected = dlx.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.every((r) => /No room of this type|just taken/.test(String(r.reason?.message)))).toBe(true);
  });

  it("uses the room chosen on the board when it is free, and refuses it when it is not", async () => {
    const w = dates();
    const r = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, roomId: roomIds["303"], ...w });
    expect(r.reservations[0].roomNumber).toBe("303");
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, roomId: roomIds["303"], ...w })).rejects.toThrow(/not available/);
  });

  it("ignores any totals or rates supplied by the browser", async () => {
    const w = dates();
    const r = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, totalMinor: 1, rateMinor: 1, quotedTotalMinor: 1, agreedRateMinor: 1 });
    // The booking freezes the server's own rate (never the browser's 1), so later price edits cannot reprice it.
    expect(r.reservations[0]).toMatchObject({ quotedTotalMinor: 900_000, agreedRateMinor: r.quote.rateMinor });
    expect(r.quote.rateMinor).toBeGreaterThan(1);
  });

  it("accepts the listed booking sources and legacy values, rejects others", async () => {
    for (const source of ["WALK_IN", "TRAVEL_AGENT", "CORPORATE", "OTA", "DIRECT_WEBSITE", "OTHER", "DIRECT"]) {
      await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: suite, ...dates(1), source })).resolves.toBeTruthy();
    }
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: suite, ...dates(1), source: "MAGIC" })).rejects.toThrow();
  });
});

describe("discounts and advance payments", () => {
  it("a discount needs permission and a reason; the agreed rate drives the room charges", async () => {
    const w = dates();
    const desk = asRole(owner, "FRONT_DESK");
    await expect(createBooking(app, desk, { newGuest: guest(), roomTypeId: deluxe, ...w, discountPercentBp: 1000, discountReason: "regular" })).rejects.toThrow(/permission/i);
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, discountPercentBp: 1000 })).rejects.toThrow(/reason/i);
    const r = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, discountPercentBp: 1000, discountReason: "Repeat guest" });
    expect(r.reservations[0]).toMatchObject({ agreedRateMinor: 405_000, discountReason: "Repeat guest", quotedTotalMinor: 810_000 });
    const log = await admin.auditLog.findFirst({ where: { tenantId: owner.tenantId, entityId: r.reservations[0].id, action: "reservation.create" } });
    expect(log?.reason).toBe("Repeat guest");
    await postRoomNights(app, owner, r.reservations[0].id);
    const entries = await admin.folioEntry.findMany({ where: { folio: { reservationId: r.reservations[0].id }, kind: "CHARGE" } });
    expect(entries.map((e) => e.balanceDeltaMinor)).toEqual([405_000, 405_000]);
  });

  it("records an advance on the folio; failures never lose the booking", async () => {
    const w = dates();
    const ok = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w, advance: { amountMinor: 200_000, method: "UPI", reference: "UTR1" } });
    expect(ok.advance).toMatchObject({ recorded: true, amountMinor: 200_000 });
    const conf = await bookingConfirmation(app, owner, ok.reservations[0].id);
    expect(conf).toMatchObject({ totalMinor: 900_000, paidMinor: 200_000, balanceMinor: 700_000 });

    const w2 = dates();
    const noShift = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w2, advance: { amountMinor: 100_000, method: "CASH" } });
    expect(noShift.reservations).toHaveLength(1);
    expect(noShift.advance.recorded).toBe(false);
    expect(noShift.advance.error).toMatch(/cash shift/i);

    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...dates(), advance: { amountMinor: 9_000_001, method: "UPI" } })).rejects.toThrow(/cannot exceed/);
    await expect(createBooking(app, asRole(owner, "RESERVATION_EXECUTIVE"), { newGuest: guest(), roomTypeId: deluxe, ...dates(), advance: { amountMinor: 100, method: "UPI" } })).rejects.toThrow(/permission/i);
  });

  it("a user without reservations.create cannot book or quote", async () => {
    const hk = asRole(owner, "HOUSEKEEPING");
    await expect(createBooking(app, hk, { newGuest: guest(), roomTypeId: deluxe, ...dates() })).rejects.toThrow(/permission/i);
    await expect(quoteStay(app, hk, { roomTypeId: deluxe, ...dates() })).rejects.toThrow(/permission/i);
  });
});

describe("tentative bookings and confirmation", () => {
  it("a tentative booking holds the room, can be confirmed, and cancelling releases it", async () => {
    const w = dates();
    const r = await createBooking(app, owner, { newGuest: guest(), roomTypeId: suite, ...w, status: "TENTATIVE" });
    expect(r.reservations[0].status).toBe("TENTATIVE");
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: suite, ...w })).rejects.toThrow(/No room of this type/);
    await confirmReservation(app, owner, r.reservations[0].id);
    expect((await admin.reservation.findUniqueOrThrow({ where: { id: r.reservations[0].id } })).status).toBe("CONFIRMED");
    await cancelReservation(app, owner, r.reservations[0].id, "guest asked");
    await expect(createBooking(app, owner, { newGuest: guest(), roomTypeId: suite, ...w })).resolves.toBeTruthy();
    const hist = await admin.reservationStatusHistory.findMany({ where: { reservationId: r.reservations[0].id }, orderBy: { changedAt: "asc" } });
    expect(hist.map((h) => h.toStatus)).toEqual(["TENTATIVE", "CONFIRMED", "CANCELLED"]);
  });

  it("the confirmation covers the whole group, and other tenants cannot read it", async () => {
    const r = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...dates(), rooms: 2, adults: 2 });
    const conf = await bookingConfirmation(app, owner, r.reservations[0].id);
    expect(conf.group).toHaveLength(2);
    expect(conf.totalMinor).toBe(1_800_000);
    await expect(bookingConfirmation(app, other, r.reservations[0].id)).rejects.toThrow(/not found/i);
    // Roles without billing access do not see payment figures.
    expect((await bookingConfirmation(app, asRole(owner, "RESERVATION_EXECUTIVE"), r.reservations[0].id)).paidMinor).toBeNull();
  });
});

describe("GST in the quote", () => {
  it("shows GST as unconfigured until an approved rule exists, then applies it", async () => {
    const f = "33ABCDE1234F1Z";
    await updateGstSettings(app, owner, { gstRegistered: true, gstin: f + gstinCheckChar(f), legalName: "Booking Co", address: "1 Beach Road", invoicePrefix: "BK" }, "setup");
    const w = dates();
    const before = await quoteStay(app, owner, { roomTypeId: deluxe, ...w });
    expect(before).toMatchObject({ taxStatus: "UNCONFIGURED", taxMinor: 0 });
    expect(before.taxNote).toMatch(/No approved tax rule/);
    // Arbitrary fixture rate, not tax advice.
    const draft = await createRule(app, owner, { category: "ROOM", description: "fixture", treatment: "TAXABLE", ratePercent: 12, effectiveFrom: "2020-01-01", legalRef: "test fixture" });
    await approveRule(app, asRole(owner, "ACCOUNTS_MANAGER"), draft.id);
    const after = await quoteStay(app, owner, { roomTypeId: deluxe, ...w });
    expect(after).toMatchObject({ taxStatus: "APPLIED", subtotalMinor: 900_000, taxMinor: 108_000, totalMinor: 1_008_000 });
    // A discount lowers the taxable value too.
    expect((await quoteStay(app, owner, { roomTypeId: deluxe, ...w, discountPercentBp: 1000 })).taxMinor).toBe(97_200);
    const r = await createBooking(app, owner, { newGuest: guest(), roomTypeId: deluxe, ...w });
    expect(r.reservations[0].quotedTotalMinor).toBe(1_008_000);
  });
});
