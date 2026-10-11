import { describe, expect, it } from "vitest";
import { dateInZone, deriveRoomStatus, paymentStatusOf, type StatusInput } from "./roomStatus";

const base: StatusInput = { outOfOrder: false, maintenanceBlock: false, housekeeping: "CLEAN", date: "2026-10-12", live: true };

describe("deriveRoomStatus", () => {
  it("is available when clean and unbooked", () => {
    expect(deriveRoomStatus(base)).toBe("AVAILABLE");
  });
  it("a future booking does not make a clean room occupied", () => {
    expect(deriveRoomStatus({ ...base, upcoming: { arrival: "2026-10-20" } })).toBe("RESERVED");
  });
  it("in-house guest is occupied until the departure date, then due out", () => {
    expect(deriveRoomStatus({ ...base, inHouse: { departure: "2026-10-13" } })).toBe("OCCUPIED");
    expect(deriveRoomStatus({ ...base, inHouse: { departure: "2026-10-12" } })).toBe("DUE_OUT");
    expect(deriveRoomStatus({ ...base, inHouse: { departure: "2026-10-11" } })).toBe("DUE_OUT");
  });
  it("dirty or being cleaned means cleaning required", () => {
    expect(deriveRoomStatus({ ...base, housekeeping: "DIRTY" })).toBe("CLEANING");
    expect(deriveRoomStatus({ ...base, housekeeping: "CLEANING" })).toBe("CLEANING");
    expect(deriveRoomStatus({ ...base, housekeeping: "INSPECTED" })).toBe("AVAILABLE");
  });
  it("out of order beats everything; maintenance beats occupancy", () => {
    const full = { ...base, inHouse: { departure: "2026-10-14" }, housekeeping: "DIRTY", upcoming: { arrival: "2026-10-15" } };
    expect(deriveRoomStatus({ ...full, outOfOrder: true, maintenanceBlock: true })).toBe("OUT_OF_ORDER");
    expect(deriveRoomStatus({ ...full, maintenanceBlock: true })).toBe("MAINTENANCE");
  });
  it("housekeeping is ignored for projected (non-today) dates", () => {
    expect(deriveRoomStatus({ ...base, live: false, housekeeping: "DIRTY" })).toBe("AVAILABLE");
    expect(deriveRoomStatus({ ...base, live: false, expectedStay: { arrival: "2026-10-11", departure: "2026-10-14" } })).toBe("OCCUPIED");
    expect(deriveRoomStatus({ ...base, live: false, expectedStay: { arrival: "2026-10-11", departure: "2026-10-12" } })).toBe("DUE_OUT");
  });
});

describe("dateInZone", () => {
  it("uses the property timezone, not UTC", () => {
    const i = new Date("2026-10-11T20:00:00Z"); // 01:30 on the 12th in India
    expect(dateInZone(i, "Asia/Kolkata")).toBe("2026-10-12");
    expect(dateInZone(i, "UTC")).toBe("2026-10-11");
  });
});

describe("paymentStatusOf", () => {
  it("classifies folios", () => {
    expect(paymentStatusOf(0, 0, 0, 0)).toBe("UNPAID");
    expect(paymentStatusOf(900, 0, 0, 900)).toBe("UNPAID");
    expect(paymentStatusOf(900, 400, 0, 500)).toBe("PARTIALLY_PAID");
    expect(paymentStatusOf(900, 900, 0, 0)).toBe("PAID");
    expect(paymentStatusOf(900, 900, 900, 900)).toBe("REFUNDED");
    expect(paymentStatusOf(900, 900, 300, 300)).toBe("PARTIALLY_REFUNDED");
  });
});
