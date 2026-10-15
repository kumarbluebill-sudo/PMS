import { describe, expect, it } from "vitest";
import { confirmationChecklist, type ChecklistFacts } from "./confirmation";

const ok: ChecklistFacts = {
  guestName: "Asha Verma", guestPhone: "9876543210", guestEmail: null, arrival: "2026-11-02", departure: "2026-11-04", today: "2026-10-20", adults: 2, children: 0,
  maxAdults: 3, maxChildren: 1, categoryName: "Deluxe", categoryActive: true, roomNumber: "101", hasRateSnapshot: true, totalMinor: 900_000, paidMinor: 300_000,
  depositRequiredMinor: 270_000, cancellationPolicy: "Free until 48 hours before arrival.",
};
const keys = (f: Partial<ChecklistFacts>, kind: "blockers" | "warnings") => confirmationChecklist({ ...ok, ...f })[kind].map((i) => i.key);

describe("confirmationChecklist", () => {
  it("passes a complete booking with nothing to flag", () => {
    const c = confirmationChecklist(ok);
    expect(c.canConfirm).toBe(true);
    expect(c.blockers).toEqual([]);
    expect(c.warnings).toEqual([]);
  });
  it("blocks on invalid dates, too many guests, an inactive category and a missing room", () => {
    expect(keys({ departure: "2026-11-02" }, "blockers")).toContain("dates");
    expect(keys({ adults: 4 }, "blockers")).toContain("guests");
    expect(keys({ children: 2 }, "blockers")).toContain("guests");
    expect(keys({ categoryActive: false }, "blockers")).toContain("category");
    expect(keys({ roomNumber: null }, "blockers")).toContain("room");
    expect(keys({ guestName: " " }, "blockers")).toContain("guest");
    expect(confirmationChecklist({ ...ok, roomNumber: null }).canConfirm).toBe(false);
  });
  it("only warns about contact, past arrival, deposit, policy, rates and a zero total", () => {
    const c = confirmationChecklist({ ...ok, guestPhone: null, arrival: "2026-10-01", paidMinor: 0, cancellationPolicy: "", hasRateSnapshot: false, totalMinor: 0 });
    expect(c.canConfirm).toBe(true);
    expect(c.warnings.map((w) => w.key).sort()).toEqual(["contact", "deposit", "future", "policy", "rate", "total"]);
  });
  it("leaves out the deposit item when the viewer cannot see money, or no deposit is asked for", () => {
    expect(confirmationChecklist({ ...ok, paidMinor: null }).items.some((i) => i.key === "deposit")).toBe(false);
    expect(confirmationChecklist({ ...ok, depositRequiredMinor: 0 }).items.some((i) => i.key === "deposit")).toBe(false);
  });
});
